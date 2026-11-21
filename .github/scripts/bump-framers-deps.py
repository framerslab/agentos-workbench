#!/usr/bin/env python3
"""
Bump every `@framers/*` version pin in a repository to `^<latest>` from the
npm registry.

Pins it rewrites, in files tracked by git:
- `package.json` entries keyed by the package name in any field but
  peerDependencies (dependencies, devDependencies, optionalDependencies,
  overrides, resolutions, pnpm.overrides), including glob resolution keys
  such as `"**/@framers/agentos"`. A peer range states the oldest host
  release a package works with; rewritten to `^<latest>` it would make npm
  refuse the package next to any other release, and since a peer-only
  change publishes nothing, the published package would keep the old range
  anyway. So peerDependencies are left for a person to set.
- `pnpm-workspace.yaml` entries under `overrides:`, `catalog:` and
  `catalogs:`. An override there wins over every `package.json` range in
  the workspace, so a stale one keeps the whole repository building
  against an old release no matter what the `package.json` files say.

A value is rewritten only when it is a semver range (node-semver grammar:
`1.2.3`, `^0.9.0`, `>=0.7.0 <0.10.0`, `^0.9.0 || ^0.10.0`, `1.x`, `*`)
that mentions no version above the latest release. Everything else is left
alone: protocols (`workspace:`, `link:`, `file:`, `npm:`, `jsr:` ...),
paths (`../agentos`, `./shim.js`, patch files), git and GitHub specs,
dist-tags (`next`), npm `$name` references, pnpm's `-` (remove), YAML
anchors and aliases, and any range that already reaches past `latest`
(such as a prerelease from the `next` channel), so a pin never moves
backwards. A range whose strict lower bound sits at or above `latest`
(`>0.10.28` when latest is 0.10.28) is left alone too, since `^latest`
would admit the release it excludes. Version-qualified selector keys such as
`"@framers/agentos@<0.10"` are not matched, because they target only the
copies inside that range.

Overrides that pin the package under one parent (pnpm `"wunderland>@framers/agentos"`,
Yarn `"wunderland/@framers/agentos"`, or an npm override nested under the
parent's key) are reported, not rewritten: they hold one consumer on a chosen version on
purpose, and moving them is a decision for a person. Pins this script
cannot rewrite safely (a nested npm override object, a YAML flow mapping,
anchor or alias, a plain value continued on the next line) are reported
the same way, and so is a flat npm override beside a root peer range for
the same package: npm requires the two to be equal and the peer range is
never rewritten, so every pin of that package in the file stays. Reports
are GitHub Actions warning annotations, so they show on the run summary.

Only regular files are read; a tracked symbolic link is skipped with a
warning. So is a manifest under a folder named `vendor`, `vendored` or
`third_party`: a vendored copy is kept byte for byte.

Only files tracked by git are read, so `node_modules`, build output and
the contents of git submodules are never touched: the pull request this
workflow opens cannot commit those, and the refreshed lockfile has to
describe the manifests that are committed.

The script checks its own rules against fixtures before it touches any
file and exits 1 if a rule misbehaves, so a broken edit to this file fails
the run instead of opening a wrong pull request (`--self-check` runs that
check alone and stops). It also exits 1 when npm
fails for any package for a reason other than "not published", so a
registry outage cannot pass as a clean run with stale pins.

Designed to run inside GitHub Actions; no external Python dependencies
beyond the standard library and `npm` on PATH.
"""

from __future__ import annotations

import itertools
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Callable

NAME = r"@framers/[a-z0-9._-]+"

# A name as a JSON key or value, plain or after a selector prefix
# (`"wunderland>@framers/agentos"`, `"**/@framers/agentos"`).
DEP_PATTERN = re.compile(rf'["/>]({NAME})"')
YAML_DEP_PATTERN = re.compile(rf"""['"]?(?:[^'"\s:]*[>/])?({NAME})['"]?\s*:""")

# node-semver range grammar: comparators joined by spaces, hyphen ranges,
# alternatives joined by `||`. Whitespace is allowed only after an
# operator and `=` is only an operator (never a version prefix), so every
# comparator has exactly one parse and a failing match cannot backtrack
# exponentially.
# A prerelease or build suffix follows a full three-part version only, as in
# node-semver: `1-release` is a dist-tag, not the version 1 with a prerelease.
_PART = r"(?:\d+|[xX*])"
_VER = rf"v?{_PART}(?:\.{_PART}(?:\.{_PART}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)?)?"
_CMP = rf"(?:(?:\^|~>?|[<>]=?|=)\s*)?{_VER}"
_SET = rf"(?:{_VER}\s+-\s+{_VER}|{_CMP}(?:\s+{_CMP})*)"
RANGE_RE = re.compile(rf"\s*{_SET}(?:\s*\|\|\s*{_SET})*\s*", re.ASCII)

# One version inside a range; a prerelease or build suffix is consumed with
# it so its own numbers are never read as a version.
VERSION_TOKEN = re.compile(
    r"(?<![\w.])[v=]?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?",
    re.ASCII,
)

# A strict lower bound (`>1.2.3`, `> 1.2`), with the parts it names; `~>` is the tilde operator.
STRICT_LOWER = re.compile(r"(?<!~)>(?!=)\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+)(-[0-9A-Za-z.-]+)?)?", re.ASCII)

# Byte-order mark, written as a code point so no invisible character sits in this file.
BOM = chr(0xFEFF)

# Top-level pnpm-workspace.yaml blocks whose entries are version pins.
YAML_PIN_BLOCKS = ("overrides", "catalog", "catalogs")

# The package.json field whose pins are never rewritten (see the module docstring).
PEER_FIELD = "peerDependencies"


def in_peer_field(path: tuple[str, ...]) -> bool:
    """True when a pin sits directly in the top-level peerDependencies field.

    A package.json's root object contributes an empty key, so the field's
    path is ("", "peerDependencies"); a fragment without the root braces
    gives ("peerDependencies",). An object named peerDependencies deeper down
    (an npm override for a package of that name, a config block) is not the
    field, and its pins follow the other rules.
    """
    return path in ((PEER_FIELD,), ("", PEER_FIELD))

Warn = Callable[[str, int, str], None]


def annotate(path: str, line: int, message: str) -> None:
    """Print a GitHub Actions warning annotation for `path:line`."""
    print(f"::warning file={path},line={line}::{message}", file=sys.stderr)


def is_registry_range(spec: str) -> bool:
    """True when `spec` is a semver range the registry resolves, not a protocol, path, tag or reference."""
    return RANGE_RE.fullmatch(spec) is not None


def mentions_newer(spec: str, latest: str) -> bool:
    """True when any version in `spec` is above `latest` (missing or wildcard parts count as 0)."""
    top = tuple(int(part) for part in latest.split("."))
    for match in VERSION_TOKEN.finditer(spec):
        parts = tuple(int(g) if g and g.isdigit() else 0 for g in match.groups())
        if parts > top:
            return True
    return False


def excludes_latest(spec: str, latest: str) -> bool:
    """True when a strict lower bound in `spec` sits at or above `latest`.

    `>0.10.28` admits nothing up to 0.10.28, and `>0.10` nothing in 0.10.x, so
    `^latest` would admit a release the range was written to exclude. Only the
    parts the bound names are compared, and a bound on a prerelease of latest
    itself excludes nothing.
    """
    # `>x` and `>*` admit nothing at all.
    if re.search(r"(?<!~)>(?!=)\s*v?[xX*]", spec):
        return True
    top = tuple(int(part) for part in latest.split("."))
    for match in STRICT_LOWER.finditer(spec):
        named = tuple(int(g) for g in match.groups()[:3] if g is not None)
        # A release is above its own prereleases: `>0.10.28-beta.0` admits 0.10.28.
        if match.group(4) and named == top:
            continue
        if named >= top[:len(named)]:
            return True
    return False


# Specifiers that are deliberately not a registry range: protocols, `-`,
# npm `$name` references, paths and git shorthands (they contain `/`), and
# dist-tags. Anything else that fails the range grammar was misread.
DELIBERATE_PREFIXES = (
    "workspace:", "catalog:", "link:", "file:", "npm:", "jsr:", "git", "github:",
    "http:", "https:", "portal:", "patch:", "$",
)


def is_deliberate_specifier(spec: str) -> bool:
    """True for a value that is intentionally not a semver range (see DELIBERATE_PREFIXES)."""
    spec = spec.strip()
    if re.search(r"[,{}\[\]]|:\s", spec):
        return False
    return (
        spec == "-" or spec.startswith(DELIBERATE_PREFIXES) or "/" in spec
        or re.fullmatch(r"[A-Za-z][\w.-]*", spec) is not None
    )


def should_rewrite(spec: str, latest: str) -> bool:
    """A pin moves to `^latest` only when it is a range that neither reaches past latest nor excludes it from below."""
    return (spec != f"^{latest}" and is_registry_range(spec)
            and not mentions_newer(spec, latest) and not excludes_latest(spec, latest))


# package.json fields whose entries force versions across the install.
OVERRIDE_FIELDS = ("overrides", "resolutions")


def decode_key(token: str) -> str:
    """The value of a JSON string token (escapes decoded), or its raw text if it does not parse."""
    try:
        value = json.loads(token)
    except ValueError:
        return token[1:-1]
    return value if isinstance(value, str) else token[1:-1]


def json_key_paths(text: str) -> dict[int, tuple[str, ...]]:
    """Map the offset of each object key's opening quote to the keys of the containers enclosing it.

    A small scanner, not a parser: it follows strings (with escapes) and
    braces only, so it works on any text the regexes below can match,
    including fragments. The root object contributes an empty key.
    """
    paths: dict[int, tuple[str, ...]] = {}
    stack: list[str] = []
    pending = ""
    i, n = 0, len(text)
    while i < n:
        char = text[i]
        if char == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            k = j + 1
            while k < n and text[k] in " \t\r\n":
                k += 1
            if k < n and text[k] == ":":
                paths[i] = tuple(stack)
                pending = decode_key(text[i:j + 1])
            i = j + 1
            continue
        if char in "{[":
            stack.append(pending)
            pending = ""
        elif char in "}]" and stack:
            stack.pop()
        i += 1
    return paths


def parent_scoped(path: tuple[str, ...], prefix: str | None) -> bool:
    """True when a pin applies under one parent package only.

    pnpm writes that as `parent>pkg`, Yarn as `parent/pkg` (only `**/` is
    global), and npm as a nested object inside `overrides`.
    """
    if prefix is not None and prefix != "**/":
        return True
    for field in OVERRIDE_FIELDS:
        if field in path:
            return len(path) > path.index(field) + 1
    return False


def json_pin_pattern(pkg: str) -> re.Pattern[str]:
    """Match `"<selector-prefix?><pkg>": "<spec>"` in package.json text.

    The optional prefix covers parent selectors (`wunderland>`) and globs
    (`**/`). The closing quote right after the name keeps
    `@framers/agentos` from matching `@framers/agentos-ext-foo`.
    """
    return re.compile(rf'("(?P<prefix>[^"]*[>/])?{re.escape(pkg)}"\s*:\s*)"(?P<spec>[^"]*)"')


def json_nested_pattern(pkg: str) -> re.Pattern[str]:
    """Match an npm nested override object such as `"<pkg>": { ".": "0.9.0" }`."""
    return re.compile(rf'"(?:[^"]*[>/])?{re.escape(pkg)}"\s*:\s*\{{')


def yaml_pin_pattern(pkg: str) -> re.Pattern[str]:
    """Match one `<indent><key>: <spec>` line of a pnpm-workspace.yaml pin block.

    The value is single-quoted, double-quoted or plain. A plain value runs
    to the end of the line or to a ` #` comment, so `^0.9.0 || ^0.10.0` is
    read whole and `framersai/agentos#main` keeps its `#`.
    """
    return re.compile(
        rf"""^(?P<indent>\s+)(?P<kq>['"]?)(?P<key>(?P<prefix>[^'"\s:]*[>/])?{re.escape(pkg)})(?P=kq)(?P<sep>\s*:\s*)"""
        r"""(?:'(?P<sq>[^'\n]*)'|"(?P<dq>[^"\n]*)"|(?P<bare>[^'"\s#](?:[^\n]*?\S)?))(?P<tail>\s+#.*|\s*)$"""
    )


def spec_of(match: re.Match[str]) -> str:
    """The pin's value as JSON reads it, escapes decoded (`^0.9.0` is `^0.9.0`)."""
    return decode_key(f'"{match.group("spec")}"')


def yaml_code(line: str) -> str:
    """One YAML line with every quoted scalar emptied and its comment removed.

    A quote opens a scalar only where one can start: at the start of the
    content or after whitespace, `:`, `,`, `[`, `{`, `-` or `?`, so the
    apostrophe in a plain key such as `don't` is text. Inside single quotes
    `''` is a quote; inside double quotes a backslash escapes the next
    character. A `#` starts a comment only outside a scalar and after
    whitespace.
    """
    out: list[str] = []
    i, n, prev = 0, len(line), " "
    while i < n:
        char = line[i]
        if char in "'\"" and (prev.isspace() or prev in ":,[{-?"):
            i += 1
            while i < n:
                if char == "'" and line[i] == "'":
                    if i + 1 < n and line[i + 1] == "'":
                        i += 2
                        continue
                    break
                if char == '"' and line[i] == "\\":
                    i += 2
                    continue
                if line[i] == char:
                    break
                i += 1
            out.append(char * 2)
            prev = char
            i += 1
            continue
        if char == "#" and prev.isspace():
            break
        out.append(char)
        prev = char
        i += 1
    return "".join(out)


def line_of(text: str, offset: int) -> int:
    """1-based line number of `offset` in `text`."""
    return text.count("\n", 0, offset) + 1


def bump_json_text(text: str, versions: dict[str, str], source: str = "<fixture>", warn: Warn = annotate) -> tuple[str, int]:
    """Rewrite registry pins in package.json text. Return the new text and the number of pins changed.

    A pin that applies under one parent package is reported instead of
    rewritten (see `parent_scoped`). A package with an npm override written
    as a nested object keeps every pin in the file, because npm rejects a
    dependency that no longer equals its override. Key paths are recomputed
    for each package because an earlier rewrite can shift offsets.
    """
    changes = 0
    for pkg, latest in versions.items():
        paths = json_key_paths(text)
        nested = [m for m in json_nested_pattern(pkg).finditer(text)
                  if any(field in paths.get(m.start(), ()) for field in OVERRIDE_FIELDS)]
        if nested:
            # npm requires a direct dependency and its "." override to match,
            # so moving one without the other breaks the install; keep both.
            for m in nested:
                warn(source, line_of(text, m.start()),
                     f"nested override for {pkg} not handled; its pins in this file are left unchanged")
            continue

        # A version-qualified override (`"@framers/agentos@>=0.9"`) still applies to the
        # release a direct pin moves to, and npm requires the two to be equal; the script
        # does not rewrite such a key. An override that reads this package's range by
        # reference (`"other": "$@framers/agentos"`) would move with it while the other
        # package's own pin stays. Either way every pin of the package here stays.
        qualified = [m for m in re.finditer(rf'"{re.escape(pkg)}@[^"]*"\s*:', text)
                     if any(field in paths.get(m.start(), ()) for field in OVERRIDE_FIELDS)]
        referenced = [m for m in re.finditer(rf'"(?P<key>[^"]+)"\s*:\s*"\${re.escape(pkg)}"', text)
                      if m.group("key") != pkg and any(field in paths.get(m.start(), ()) for field in OVERRIDE_FIELDS)]
        if qualified or referenced:
            for m in qualified:
                warn(source, line_of(text, m.start()),
                     f"version-qualified override for {pkg} not handled; its pins in this file are left unchanged")
            for m in referenced:
                warn(source, line_of(text, m.start()),
                     f"override of {m.group('key')} reads {pkg}'s range; its pins in this file are left unchanged")
            continue

        # npm refuses an install whose flat override for a package differs from the
        # root's own range for it (EOVERRIDE). The root's peer range is never
        # rewritten, so beside one the override, and with it every pin of the
        # package in this file, stays where it is.
        pins = list(json_pin_pattern(pkg).finditer(text))
        flat_overrides = [m for m in pins if m.group("prefix") is None
                          and paths.get(m.start(), ()) in (("overrides",), ("", "overrides"))]
        if (flat_overrides and any(in_peer_field(paths.get(m.start(), ())) for m in pins)
                and any(should_rewrite(spec_of(m), latest) for m in pins
                        if not in_peer_field(paths.get(m.start(), ())))):
            for m in flat_overrides:
                warn(source, line_of(text, m.start()),
                     f"override for {pkg} sits beside a root peer range it must equal; its pins in this file are left unchanged")
            continue

        def replace(match: re.Match[str], _pkg: str = pkg, _latest: str = latest,
                    _paths: dict[int, tuple[str, ...]] = paths) -> str:
            nonlocal changes
            if in_peer_field(_paths.get(match.start(), ())):
                return match.group(0)
            if not should_rewrite(spec_of(match), _latest):
                return match.group(0)
            if parent_scoped(_paths.get(match.start(), ()), match.group("prefix")):
                warn(source, line_of(text, match.start()),
                     f"override pins {_pkg} under a parent ({spec_of(match)}); left for a person to move to ^{_latest}")
                return match.group(0)
            changes += 1
            return f'{match.group(1)}"^{_latest}"'

        text = json_pin_pattern(pkg).sub(replace, text)
    return text, changes


def bump_yaml_text(text: str, versions: dict[str, str], source: str = "<fixture>", warn: Warn = annotate) -> tuple[str, int]:
    """Rewrite registry pins inside the pin blocks of pnpm-workspace.yaml text.

    The root mapping's indentation comes from the first content line, so a
    file indented as a whole is read too. A line at that indentation opens
    a new top-level block (quoted keys included); only deeper lines under
    `overrides:`, `catalog:` or `catalogs:` are candidates, so a `packages:`
    glob, a patch path or a comment is never touched. A pin this script
    cannot rewrite safely (a flow mapping, a YAML anchor, alias or tag, a
    plain value continued on the next line, an override nested under a
    parent, or a line no pattern reads) is reported, not rewritten.
    """
    bom = text.startswith(BOM)
    if bom:
        text = text[1:]
    lines = text.split("\n")
    out: list[str] = []
    changes = 0
    block = None
    entry_indent = None
    flow_indent = None
    patterns = {pkg: yaml_pin_pattern(pkg) for pkg in versions}
    exact_keys = {pkg: re.compile(rf"""['"\s>/{{,]{re.escape(pkg)}['"]?\s*:""") for pkg in versions}

    def indent_of(line: str) -> int:
        return len(line) - len(line.lstrip(" \t"))

    def is_content(line: str) -> bool:
        stripped = line.strip()
        return bool(stripped) and not stripped.startswith("#") and stripped not in ("---", "...")

    root_indent = next((indent_of(line) for line in lines if is_content(line)), 0)
    for idx, line in enumerate(lines):
        number = idx + 1
        if line.strip() in ("---", "..."):
            block = None
        elif is_content(line) and indent_of(line) <= root_indent:
            body = line[indent_of(line):]
            top = re.match(r"""^(['"]?)([A-Za-z][\w-]*)\1\s*:""", body)
            block = top.group(2) if top else None
            entry_indent = None
            flow_indent = None
            # A flow value here may carry an anchor or tag first (`catalog: &shared {`).
            if block in YAML_PIN_BLOCKS and re.match(r"""^[^:]*:\s*(?:[&!]\S*\s+)*[{\[]""", body):
                warn(source, number, "inline (flow) mapping not handled; check its @framers pins by hand")
                block = None
        elif block in YAML_PIN_BLOCKS and is_content(line):
            indent = indent_of(line)
            # Inside a flow collection opened by an earlier nested key: copy the
            # lines through its closing bracket unchanged.
            if flow_indent is not None:
                if indent > flow_indent or (indent == flow_indent and line.strip()[:1] in "}]"):
                    out.append(line)
                    continue
                flow_indent = None
            # A nested key whose value opens a flow collection (`shared: {`), or a
            # bare `{` / `[` under such a key: its entries cannot be rewritten line
            # by line, so report and skip them through the closing bracket.
            # Read with quoted scalars emptied and the comment removed, so a bracket,
            # a `#` or a quote inside a key is not counted.
            code = yaml_code(line)
            if re.match(r"""^\s*(?:\S[^#]*?:\s*)?(?:[&!]\S*\s+)*[{\[]""", code):
                span = [line]
                depth = code.count("{") + code.count("[") - code.count("}") - code.count("]")
                if depth > 0:
                    flow_indent = indent
                    for later in itertools.islice(lines, idx + 1, None):
                        if later.strip().startswith("#"):
                            span.append(later)
                            continue
                        if later.strip() and indent_of(later) <= indent and later.strip()[:1] not in "}]":
                            break
                        span.append(later)
                        if later.strip() and indent_of(later) == indent and later.strip()[:1] in "}]":
                            break
                if any(key.search(part) for key in exact_keys.values() for part in span):
                    warn(source, number, "inline (flow) mapping not handled; check its @framers pins by hand")
                out.append(line)
                continue
            if entry_indent is None:
                entry_indent = indent
            # pnpm overrides are a flat map; an entry indented under another key
            # is scoped to that key (a parent), so it is reported like `parent>pkg`.
            nested_override = block == "overrides" and indent > entry_indent
            # A deeper content line after a plain value (comments in between or
            # not) continues it; rewriting only the first line would break the file.
            following = next((later for later in itertools.islice(lines, idx + 1, None) if is_content(later)), "")
            continued = bool(following) and indent_of(following) > indent
            matched = False
            for pkg, pattern in patterns.items():
                match = pattern.match(line)
                if not match:
                    continue
                matched = True
                latest = versions[pkg]
                if match.group("sq") is not None:
                    spec, quote = match.group("sq"), "'"
                elif match.group("dq") is not None:
                    spec, quote = match.group("dq"), '"'
                else:
                    spec, quote = match.group("bare"), "'"
                    if spec[0] in "&*!":
                        warn(source, number, f"YAML anchor, alias or tag on the {pkg} pin; check it by hand")
                        break
                    if continued:
                        warn(source, number, f"multi-line value on the {pkg} pin; check it by hand")
                        break
                if not is_registry_range(spec) and not is_deliberate_specifier(spec):
                    warn(source, number, "could not read this pin; left unchanged")
                    break
                if not should_rewrite(spec, latest):
                    break
                if nested_override or ">" in (match.group("prefix") or ""):
                    warn(source, number, f"override pins {pkg} under a parent ({spec}); left for a person to move to ^{latest}")
                    break
                line = (
                    f"{match.group('indent')}{match.group('kq')}{match.group('key')}{match.group('kq')}"
                    f"{match.group('sep')}{quote}^{latest}{quote}{match.group('tail')}"
                )
                changes += 1
                break
            if not matched and any(key.search(line) for key in exact_keys.values()):
                warn(source, number, "could not read this pin; left unchanged")
        out.append(line)
    result = "\n".join(out)
    return (BOM + result if bom else result), changes


def self_check() -> None:
    """Exit 1 unless the rewriting rules behave as documented on fixed inputs."""
    versions = {"@framers/agentos": "0.10.28", "@framers/sql-storage-adapter": "0.6.8"}
    warnings: list[str] = []

    def collect(_source: str, line: int, message: str) -> None:
        warnings.append(f"{line}:{message.split(';')[0]}")

    unchanged = [
        '"@framers/agentos": "^0.10.28"',
        '"@framers/agentos": "workspace:*"',
        '"@framers/agentos": "link:../agentos"',
        '"@framers/agentos": "jsr:@framers/agentos@1"',
        '"@framers/agentos": "$@framers/agentos"',
        '"@framers/agentos": "-"',
        '"@framers/agentos": "next"',
        # A dist-tag may start with a digit; npm reads neither of these as a range.
        '"@framers/agentos": "0-release"',
        '"@framers/agentos": "1-release"',
        # A strict lower bound at latest admits nothing up to latest.
        '"@framers/agentos": ">0.10.28"',
        '"@framers/agentos": ">0.10"',
        # `>x` admits nothing at all.
        '"@framers/agentos": ">x"',
        '"@framers/agentos": "./src/shims/agentos.browser.js"',
        '"@framers/agentos": "../agentos"',
        '"@framers/agentos": "framersai/agentos#feat"',
        '"@framers/agentos": "patches/@framers__agentos.patch"',
        '"(.*)/@framers/agentos": "<rootDir>/__mocks__/agentos.js"',
        '"@framers/agentos": "^0.11.0"',
        '"@framers/agentos": "0.11.0-beta.2"',
        '"@framers/agentos": "0.10.29-next.0"',
        '"@framers/agentos": ">=0.7.0 <0.11.0"',
        '"@framers/agentos@<0.10": "0.9.1"',
        '"@framers/agentos-ext-foo": "^0.1.0"',
        '"name": "@framers/agentos"',
        # Fails to parse (an empty last alternative), and must fail fast.
        '"@framers/agentos": "' + '=0 ' * 22 + '||"',
        '"peerDependencies": { "@framers/agentos": "^0.10.28" },\n"peerDependenciesMeta": { "@framers/agentos": { "optional": true } }',
        # Peer ranges are never rewritten, stale or not.
        '{"peerDependencies": {"@framers/agentos": ">=0.7.0"}}',
        '{"peerDependencies": {"@framers/agentos": "^0.9.135", "@framers/sql-storage-adapter": "^0.6.1"}}',
    ]
    rewritten = [
        ('"@framers/agentos": "^0.9.135"', '"@framers/agentos": "^0.10.28"'),
        ('"@framers/agentos": "0.10.0"', '"@framers/agentos": "^0.10.28"'),
        ('"@framers/agentos": ">=0.7.0"', '"@framers/agentos": "^0.10.28"'),
        ('"@framers/agentos": ">= 0.7.0"', '"@framers/agentos": "^0.10.28"'),
        ('"@framers/agentos": ">0.9"', '"@framers/agentos": "^0.10.28"'),
        ('"@framers/agentos": "~>0.10.20"', '"@framers/agentos": "^0.10.28"'),
        # A JSON escape in the value is read as the character it stands for.
        ('"@framers/agentos": "\\u005e0.9.135"', '"@framers/agentos": "^0.10.28"'),
        # A release is above its own prereleases, so this bound admits latest.
        ('"@framers/agentos": ">0.10.28-beta.0"', '"@framers/agentos": "^0.10.28"'),
        ('"@framers/agentos": ">=0.9.0 <0.10.0"', '"@framers/agentos": "^0.10.28"'),
        ('"@framers/agentos": "^0.9.0 || ^0.10.0"', '"@framers/agentos": "^0.10.28"'),
        ('"@framers/agentos": "0.10.0-beta.12"', '"@framers/agentos": "^0.10.28"'),
        ('"@framers/agentos": "*"', '"@framers/agentos": "^0.10.28"'),
        ('"**/@framers/agentos": "0.9.1"', '"**/@framers/agentos": "^0.10.28"'),
        ('{"overrides": {"@framers/agentos": "0.9.1"}}', '{"overrides": {"@framers/agentos": "^0.10.28"}}'),
        ('{"pnpm": {"overrides": {"@framers/agentos": "^0.9.135"}}}', '{"pnpm": {"overrides": {"@framers/agentos": "^0.10.28"}}}'),
        # The same pin moves under dependencies while the peer stays.
        ('{"dependencies": {"@framers/agentos": "^0.9.135"}, "peerDependencies": {"@framers/agentos": "^0.9.135"}}',
         '{"dependencies": {"@framers/agentos": "^0.10.28"}, "peerDependencies": {"@framers/agentos": "^0.9.135"}}'),
        # An object named peerDependencies below the root is not the field.
        ('{"config": {"peerDependencies": {"@framers/agentos": "^0.9.135"}}}',
         '{"config": {"peerDependencies": {"@framers/agentos": "^0.10.28"}}}'),
    ]
    json_warned = [
        ('"wunderland>@framers/agentos": "0.9.138"', "1:override pins @framers/agentos under a parent (0.9.138)"),
        ('"overrides": {\n  "@framers/agentos": { ".": "0.9.135" }\n}', "2:nested override for @framers/agentos not handled"),
        ('{\n  "overrides": {\n    "wunderland": {\n      "@framers/agentos": "0.9.138"\n    }\n  }\n}',
         "4:override pins @framers/agentos under a parent (0.9.138)"),
        ('"resolutions": { "wunderland/@framers/agentos": "0.9.138" }', "1:override pins @framers/agentos under a parent (0.9.138)"),
        # An npm override under a parent package named peerDependencies is still parent-scoped.
        ('{"overrides": {"peerDependencies": {"@framers/agentos": "0.9.138"}}}',
         "1:override pins @framers/agentos under a parent (0.9.138)"),
        ('{"dependencies": {"@framers/agentos": "^0.9.135"}, "overrides": {"@framers/agentos": {".": "^0.9.135"}}}',
         "1:nested override for @framers/agentos not handled"),
        # npm refuses a flat override that differs from the root's own range for the
        # package, and the peer range stays, so nothing of the package moves.
        ('{"peerDependencies": {"@framers/agentos": "^0.9.135"}, "overrides": {"@framers/agentos": "^0.9.135"}}',
         "1:override for @framers/agentos sits beside a root peer range it must equal"),
        ('{"dependencies": {"@framers/agentos": "^0.9.135"}, "peerDependencies": {"@framers/agentos": "^0.9.135"},'
         ' "overrides": {"@framers/agentos": "^0.9.135"}}',
         "1:override for @framers/agentos sits beside a root peer range it must equal"),
        # A version-qualified override still applies to the release the pin would move to.
        ('{"dependencies": {"@framers/agentos": "^0.9.135"}, "overrides": {"@framers/agentos@>=0.9.0": "^0.9.135"}}',
         "1:version-qualified override for @framers/agentos not handled"),
        # An override that reads this package's range by reference would move with it.
        ('{"dependencies": {"@framers/agentos": "^0.9.135", "other": "^0.9.135"}, "overrides": {"other": "$@framers/agentos"}}',
         "1:override of other reads @framers/agentos's range"),
        # The key below is `overrides` with its first letter written as a JSON escape.
        ('{"' + chr(92) + 'u006fverrides": {"wunderland": {"@framers/agentos": "0.9.138"}}}',
         "1:override pins @framers/agentos under a parent (0.9.138)"),
    ]
    yaml_in = "\n".join([
        "packages:",
        "  - '@framers/agentos: 0.1.0'",
        "overrides:",
        '  "@framers/agentos": "^0.9.135"',
        "  '@framers/sql-storage-adapter': 0.6.1  # keep this comment",
        "  wunderland>@framers/agentos: 0.9.138",
        "  '@framers/agentos-ext-foo': ^0.1.0",
        "catalog:",
        "  '@framers/agentos': workspace:*",
        "catalogs:",
        "  next:",
        "    '@framers/agentos': ^0.10.0",
        "  quoted:",
        "    '@framers/agentos': '>=0.9.0 <0.10.0'",
        "  bare:",
        "    '@framers/agentos': ^0.9.0 || ^0.10.0  # two ranges",
        "  git:",
        "    '@framers/agentos': framersai/agentos#main",
        "  newer:",
        "    '@framers/agentos': ^0.11.0",
        "  alias:",
        "    '@framers/agentos': *pinned",
        "'patchedDependencies':",
        "  '@framers/agentos': patches/@framers__agentos.patch",
        "onlyBuiltDependencies:",
        "  - '@framers/agentos'",
        "",
    ])
    yaml_out = "\n".join([
        "packages:",
        "  - '@framers/agentos: 0.1.0'",
        "overrides:",
        '  "@framers/agentos": "^0.10.28"',
        "  '@framers/sql-storage-adapter': '^0.6.8'  # keep this comment",
        "  wunderland>@framers/agentos: 0.9.138",
        "  '@framers/agentos-ext-foo': ^0.1.0",
        "catalog:",
        "  '@framers/agentos': workspace:*",
        "catalogs:",
        "  next:",
        "    '@framers/agentos': '^0.10.28'",
        "  quoted:",
        "    '@framers/agentos': '^0.10.28'",
        "  bare:",
        "    '@framers/agentos': '^0.10.28'  # two ranges",
        "  git:",
        "    '@framers/agentos': framersai/agentos#main",
        "  newer:",
        "    '@framers/agentos': ^0.11.0",
        "  alias:",
        "    '@framers/agentos': *pinned",
        "'patchedDependencies':",
        "  '@framers/agentos': patches/@framers__agentos.patch",
        "onlyBuiltDependencies:",
        "  - '@framers/agentos'",
        "",
    ])
    yaml_warned = [
        "6:override pins @framers/agentos under a parent (0.9.138)",
        "22:YAML anchor, alias or tag on the @framers/agentos pin",
    ]
    special = [
        ("overrides:\r\n  '@framers/agentos': ^0.9.135\r\n", "overrides:\r\n  '@framers/agentos': '^0.10.28'\r\n", 1, []),
        (BOM + "overrides:\n  '@framers/agentos': ^0.9.135\n", BOM + "overrides:\n  '@framers/agentos': '^0.10.28'\n", 1, []),
        ("overrides: {'@framers/agentos': ^0.9.135}\n", "overrides: {'@framers/agentos': ^0.9.135}\n", 0,
         ["1:inline (flow) mapping not handled"]),
        ("overrides: {\n  '@framers/agentos': ^0.9.135,\n}\n", "overrides: {\n  '@framers/agentos': ^0.9.135,\n}\n", 0,
         ["1:inline (flow) mapping not handled"]),
        ("catalog: &shared { '@framers/agentos': ^0.9.135 }\ncatalogs:\n  shared: *shared\n",
         "catalog: &shared { '@framers/agentos': ^0.9.135 }\ncatalogs:\n  shared: *shared\n", 0,
         ["1:inline (flow) mapping not handled"]),
        ("catalogs:\n  shared: &shared {\n    '@framers/agentos': ^0.9.135\n  }\n",
         "catalogs:\n  shared: &shared {\n    '@framers/agentos': ^0.9.135\n  }\n", 0,
         ["2:inline (flow) mapping not handled"]),
        ("catalog:\n  '@framers/agentos': ^0.9.0\n    || ^0.11.0\n", "catalog:\n  '@framers/agentos': ^0.9.0\n    || ^0.11.0\n", 0,
         ["2:multi-line value on the @framers/agentos pin"]),
        ("  overrides:\n    '@framers/agentos': ^0.9.135\n", "  overrides:\n    '@framers/agentos': '^0.10.28'\n", 1, []),
        ("catalog:\n  '@framers/agentos': ^0.9.0\n    # comment\n    || ^0.10.0\n",
         "catalog:\n  '@framers/agentos': ^0.9.0\n    # comment\n    || ^0.10.0\n", 0,
         ["2:multi-line value on the @framers/agentos pin"]),
        ("catalog:\n  '@framers/agentos': ^0.9.135\n  # trailing comment\n  lodash: ^4.17.21\n",
         "catalog:\n  '@framers/agentos': '^0.10.28'\n  # trailing comment\n  lodash: ^4.17.21\n", 1, []),
        ("catalogs:\n  shared: {\n    '@framers/agentos': ^0.9.135,\n    lodash: ^4.17.21\n  }\n",
         "catalogs:\n  shared: {\n    '@framers/agentos': ^0.9.135,\n    lodash: ^4.17.21\n  }\n", 0,
         ["2:inline (flow) mapping not handled"]),
        ("catalogs:\n  shared: {\n  # shared versions\n    '@framers/agentos': ^0.9.135,\n  }\n",
         "catalogs:\n  shared: {\n  # shared versions\n    '@framers/agentos': ^0.9.135,\n  }\n", 0,
         ["2:inline (flow) mapping not handled"]),
        ("catalogs:\n  shared: { # }\n    '@framers/agentos': ^0.9.135,\n  }\n",
         "catalogs:\n  shared: { # }\n    '@framers/agentos': ^0.9.135,\n  }\n", 0,
         ["2:inline (flow) mapping not handled"]),
        ("catalog:\n  '@framers/agentos': ^0.9.135,\n", "catalog:\n  '@framers/agentos': ^0.9.135,\n", 0,
         ["2:could not read this pin"]),
        ("catalogs:\n  shared:\n    {\n      '@framers/agentos': ^0.9.135, 'wunderland/@framers/agentos': 0.9.138\n    }\n",
         "catalogs:\n  shared:\n    {\n      '@framers/agentos': ^0.9.135, 'wunderland/@framers/agentos': 0.9.138\n    }\n", 0,
         ["3:inline (flow) mapping not handled"]),
        ("catalog:\n  '@framers/agentos': ^0.9.135, 'wunderland/@framers/agentos': 0.9.138\n",
         "catalog:\n  '@framers/agentos': ^0.9.135, 'wunderland/@framers/agentos': 0.9.138\n", 0,
         ["2:could not read this pin"]),
        ("catalogs:\n  other: {\n    lodash: ^4.17.21\n  }\n  main:\n    '@framers/agentos': ^0.9.135\n",
         "catalogs:\n  other: {\n    lodash: ^4.17.21\n  }\n  main:\n    '@framers/agentos': '^0.10.28'\n", 1, []),
        # A bracket inside a quoted key is not part of the flow mapping's depth.
        ("catalogs:\n  \"ci}\": {\n    '@framers/agentos': ^0.9.135\n  }\n",
         "catalogs:\n  \"ci}\": {\n    '@framers/agentos': ^0.9.135\n  }\n", 0,
         ["2:inline (flow) mapping not handled"]),
        # An apostrophe inside a plain key opens no quote, so the `#` after it starts a comment.
        ("catalogs:\n  don't: { # '\n    '@framers/agentos': ^0.9.135\n  }\n",
         "catalogs:\n  don't: { # '\n    '@framers/agentos': ^0.9.135\n  }\n", 0,
         ["2:inline (flow) mapping not handled"]),
        # A `#` inside a quoted key is part of the key.
        ("catalogs:\n  \"ci # staging\": {\n    '@framers/agentos': ^0.9.135\n  }\n",
         "catalogs:\n  \"ci # staging\": {\n    '@framers/agentos': ^0.9.135\n  }\n", 0,
         ["2:inline (flow) mapping not handled"]),
        # An escaped quote does not close a double-quoted key.
        ("catalogs:\n  \"ci{\\\"}\": {\n    '@framers/agentos': ^0.9.135\n  }\n",
         "catalogs:\n  \"ci{\\\"}\": {\n    '@framers/agentos': ^0.9.135\n  }\n", 0,
         ["2:inline (flow) mapping not handled"]),
        ("overrides:\n  '@framers/sql-storage-adapter': 0.6.1\n  wunderland:\n    '@framers/agentos': 0.9.138\n",
         "overrides:\n  '@framers/sql-storage-adapter': '^0.6.8'\n  wunderland:\n    '@framers/agentos': 0.9.138\n", 1,
         ["4:override pins @framers/agentos under a parent (0.9.138)"]),
    ]
    failures = []
    for given in unchanged:
        got, n = bump_json_text(given, versions, warn=collect)
        if got != given or n:
            failures.append(f"package.json: {given!r} -> {got!r}, want it unchanged")
    for given, want in rewritten:
        got, n = bump_json_text(given, versions, warn=collect)
        if got != want or n != 1:
            failures.append(f"package.json: {given!r} -> {got!r}, want {want!r}")
    if warnings:
        failures.append(f"package.json: unexpected warnings {warnings}")
    for given, want_warning in json_warned:
        warnings.clear()
        got, n = bump_json_text(given, versions, warn=collect)
        if got != given or n or warnings != [want_warning]:
            failures.append(f"package.json: {given!r} -> {got!r}, warnings {warnings}, want unchanged with [{want_warning!r}]")
    warnings.clear()
    got, n = bump_yaml_text(yaml_in, versions, warn=collect)
    if got != yaml_out or n != 5 or warnings != yaml_warned:
        failures.append(f"pnpm-workspace.yaml: {n} changes, warnings {warnings}, output:\n{got}")
    for given, want, want_n, want_warnings in special:
        warnings.clear()
        got, n = bump_yaml_text(given, versions, warn=collect)
        if got != want or n != want_n or warnings != want_warnings:
            failures.append(f"pnpm-workspace.yaml: {given!r} -> {got!r} ({n} changes, warnings {warnings})")

    class _Proc:
        def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
            self.returncode, self.stdout, self.stderr = returncode, stdout, stderr

    def fake_npm(argv: list[str], **_kwargs: object) -> _Proc:
        """npm view against a fixed registry: one package absent, one whose latest tag names a missing version."""
        if argv[1] == "dist-tag":
            # The tag listing reads no version; it answers for any package the registry holds.
            # The registry answers 401 for the tags of a scoped package it does not hold.
            if argv[3] == "@framers/gone":
                return _Proc(1, stderr="npm error code E401")
            if argv[3] == "@framers/flaky":
                # The registry's own text may name another code; only npm's code line counts.
                return _Proc(1, stderr="npm error code E500\nnpm error 500 Internal Server Error - upstream answered E404")
            return _Proc(0, stdout="latest: 9.9.9\n")
        target = argv[2]
        # A package with a stale latest tag and only a prerelease left: no view spec matches.
        # @framers/flaky is the same package on a day the tag listing fails.
        if target.startswith(("@framers/pre-only", "@framers/flaky")):
            return _Proc(1, stderr="npm error code E404")
        # npm view resolves the latest tag for a bare name and for `@*` alike, so both
        # fail like `@latest` does; a real range is matched against the versions.
        if target in ("@framers/gone@latest", "@framers/gone", "@framers/gone@*", "@framers/gone@>=0.0.0",
                      "@framers/stale-tag@latest", "@framers/stale-tag", "@framers/stale-tag@*"):
            return _Proc(1, stderr="npm error code E404")
        if target == "@framers/stale-tag@>=0.0.0":
            return _Proc(0, stdout="@framers/stale-tag\n")
        return _Proc(0, stdout="1.2.3\n")

    resolved, failed = query_latest_versions(
        ["@framers/flaky", "@framers/gone", "@framers/ok", "@framers/pre-only", "@framers/stale-tag"],
        run=fake_npm, say=lambda _message: None)
    if resolved != {"@framers/ok": "1.2.3"} or failed != ["@framers/flaky", "@framers/pre-only", "@framers/stale-tag"]:
        failures.append(f"npm view: resolved {resolved}, failed {failed}; want @framers/ok at 1.2.3, "
                        "@framers/gone skipped, @framers/flaky, @framers/pre-only and @framers/stale-tag failed")
    for name, want in [("tools/vendor/analytics-consent/package.json", True),
                       ("third_party/x/pnpm-workspace.yaml", True),
                       ("packages/vendor-tools/package.json", False),
                       ("package.json", False)]:
        if is_vendored(name) != want:
            failures.append(f"vendored paths: is_vendored({name!r}) is {is_vendored(name)}, want {want}")
    if failures:
        print("self-check failed:\n" + "\n".join(failures), file=sys.stderr)
        sys.exit(1)


def read_text(path: Path) -> str | None:
    """Read a file as UTF-8 with its line endings preserved; None (with a warning) when it cannot be read."""
    try:
        with open(path, encoding="utf-8", newline="") as handle:
            return handle.read()
    except (OSError, UnicodeDecodeError) as error:
        annotate(str(path), 1, f"skipped, could not read as UTF-8 ({type(error).__name__})")
        return None


def write_text(path: Path, text: str) -> None:
    """Write UTF-8 without translating line endings."""
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)


# Folder names that hold a copy of someone else's files.
VENDOR_DIRS = ("vendor", "vendored", "third_party")


def is_vendored(name: str) -> bool:
    """True when a tracked path lies under a folder that holds vendored copies.

    A vendored manifest is a copy kept byte for byte, often pinned by a hash;
    its pins belong to the place it was copied from.
    """
    return any(part in VENDOR_DIRS for part in Path(name).parts[:-1])


def tracked_files() -> tuple[list[Path], list[Path]]:
    """Every tracked package.json and pnpm-workspace.yaml in this repository.

    `git ls-files` never lists submodule contents, `node_modules` or other
    untracked output, which is exactly the set the pull request can commit.
    """
    result = subprocess.run(
        ["git", "ls-files", "-z", "--", ":(glob)**/package.json", ":(glob)**/pnpm-workspace.yaml"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"git ls-files failed: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    paths = []
    for name in result.stdout.split("\0"):
        if not name:
            continue
        path = Path(name)
        # Reading or writing through a tracked link would change its target, which
        # may be a file the pull request cannot commit.
        if path.is_symlink():
            annotate(name, 1, "skipped, a symbolic link; only regular tracked files are rewritten")
            continue
        if is_vendored(name):
            annotate(name, 1, "skipped, a vendored copy; its pins are set where it was copied from")
            continue
        paths.append(path)
    return ([p for p in paths if p.name == "package.json"],
            [p for p in paths if p.name == "pnpm-workspace.yaml"])


def find_framers_deps(texts: dict[Path, str]) -> list[str]:
    """Discover every unique `@framers/<name>` referenced across the files."""
    deps: set[str] = set()
    for path, text in texts.items():
        pattern = YAML_DEP_PATTERN if path.name == "pnpm-workspace.yaml" else DEP_PATTERN
        deps.update(pattern.findall(text))
    return sorted(deps)


# The line on which npm states an error's primary code (`npm ERR! code` before npm 10).
_NPM_CODE = re.compile(r"^npm (?:error|ERR!) code (\S+)\s*$", re.MULTILINE)


def npm_code(stderr: str) -> str:
    """The primary error code npm reported, or "" when it reported none.

    Read from npm's own code line, never from the rest of the output, which
    can quote registry text that names another code.
    """
    match = _NPM_CODE.search(stderr)
    return match.group(1) if match else ""


def _say(message: str) -> None:
    print(message, file=sys.stderr)


def query_latest_versions(pkgs: list[str], run: Callable = subprocess.run,
                          say: Callable[[str], None] = _say) -> tuple[dict[str, str], list[str]]:
    """Look up the `latest` dist-tag of each package.

    Returns the resolved versions and the packages npm failed on. A package
    the registry does not hold (E404 for the package itself), or whose
    `latest` is not a plain release, is skipped; any other failure, an E404
    for the `latest` tag of a published package among them, is returned so
    the run can fail.
    """
    versions: dict[str, str] = {}
    failed: list[str] = []
    for pkg in pkgs:
        try:
            proc = run(
                ["npm", "view", f"{pkg}@latest", "version"],
                capture_output=True, text=True, timeout=60,
            )
        except (subprocess.TimeoutExpired, OSError) as error:
            say(f"  {pkg}: npm failed ({type(error).__name__})")
            failed.append(pkg)
            continue
        ver = proc.stdout.strip()
        if proc.returncode == 0 and re.fullmatch(r"\d+\.\d+\.\d+", ver):
            versions[pkg] = ver
        elif npm_code(proc.stderr) == "E404":
            # npm answers E404 both for a package the registry does not hold and for
            # one whose `latest` tag names a version it no longer serves. Only the
            # first is skipped; the second fails the run before anything is written.
            # The probe asks for a real range (`@>=0.0.0`), which npm matches against
            # the published versions. A bare name and `@*` both resolve `latest`
            # again (npm view reads the tag unless the spec is something other
            # than `*`) and would answer E404 for the stale tag too.
            try:
                probe = run(["npm", "view", f"{pkg}@>=0.0.0", "name"], capture_output=True, text=True, timeout=60)
                absent = probe.returncode != 0 and npm_code(probe.stderr) == "E404"
                # A range matches no prerelease, so a package left with prereleases
                # alone fails that probe too. The tag listing reads no version: when
                # it answers, the registry holds the package. The registry answers
                # it with 401 or 404 for a package it does not hold; any other
                # failure is a registry error and proves nothing, so the run fails.
                if absent:
                    tags = run(["npm", "dist-tag", "ls", pkg], capture_output=True, text=True, timeout=60)
                    if tags.returncode == 0 or npm_code(tags.stderr) not in ("E401", "E404"):
                        absent = False
            except (subprocess.TimeoutExpired, OSError):
                absent = False
            if absent:
                say(f"  skipped {pkg}: not published")
            else:
                say(f"  {pkg}: its latest tag resolves to no version (E404) and the registry did not confirm the package is unpublished")
                failed.append(pkg)
        elif proc.returncode == 0:
            say(f"  skipped {pkg}: latest is not a plain release ({ver!r})")
        else:
            say(f"  {pkg}: npm failed: {proc.stderr.strip()[:200]}")
            failed.append(pkg)
    return versions, failed


def bump_path(path: Path, text: str, versions: dict[str, str]) -> int:
    """Rewrite one file in place from its already-read text. Return the number of pins changed."""
    bump = bump_yaml_text if path.name == "pnpm-workspace.yaml" else bump_json_text
    new_text, changes = bump(text, versions, str(path))
    if new_text != text:
        write_text(path, new_text)
    return changes


def main() -> int:
    self_check()
    if "--self-check" in sys.argv[1:]:
        print("self-check passed", file=sys.stderr)
        return 0
    pkg_files, yaml_files = tracked_files()
    texts = {path: text for path in pkg_files + yaml_files if (text := read_text(path)) is not None}
    framers_deps = find_framers_deps(texts)
    print(
        f"Found {len(framers_deps)} unique @framers/* packages across "
        f"{len(pkg_files)} package.json and {len(yaml_files)} pnpm-workspace.yaml files",
        file=sys.stderr,
    )

    versions, failed = query_latest_versions(framers_deps)
    print(f"Resolved {len(versions)} packages to latest npm-published versions", file=sys.stderr)
    if failed:
        print(f"npm failed for {', '.join(failed)}; failing instead of opening a partial bump", file=sys.stderr)
        return 1

    total_changes = 0
    files_changed = 0
    for path, text in texts.items():
        changed = bump_path(path, text, versions)
        if changed:
            files_changed += 1
            total_changes += changed
            print(f"  {path}: {changed} pin(s)", file=sys.stderr)
    print(f"Updated {files_changed} files, applied {total_changes} pin bumps", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
