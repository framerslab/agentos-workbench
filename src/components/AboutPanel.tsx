export function AboutPanel() {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-white/10 dark:bg-slate-900/60">
      <header className="mb-3">
        <p className="text-[10px] uppercase tracking-[0.35em] text-slate-500 dark:text-slate-400">About</p>
        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">AgentOS Client</h3>
      </header>

      <div className="space-y-4 text-sm text-slate-700 dark:text-slate-200">
        <p>
          AgentOS orchestrates personas, tools, memory, and workflows for AI agencies. This client is a
          developer workbench for composing requests, managing agencies, and inspecting real-time outputs.
        </p>
        <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-slate-900/40">
          <p className="text-xs uppercase tracking-[0.35em] text-slate-500 dark:text-slate-400">Default assistants</p>
          <ul className="mt-2 list-disc pl-5">
            <li><span className="font-semibold">Nerf</span>: offline-first, smallest models, no internet/tools.</li>
            <li><span className="font-semibold">V</span>: full-powered researcher, tools enabled, any model family.</li>
          </ul>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-slate-900/40">
          <p className="text-xs uppercase tracking-[0.35em] text-slate-500 dark:text-slate-400">Data & Privacy</p>
          <p className="mt-2 text-sm">Your data is stored locally in your browser using IndexedDB. Use Export/Import to move data between machines. Clear storage from Settings → Data.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-slate-900/40">
            <p className="text-xs uppercase tracking-[0.35em] text-slate-500 dark:text-slate-400">Project</p>
            <ul className="mt-2 space-y-1 text-sm">
              <li>
                <a href="https://agentos.sh" target="_blank" rel="noreferrer" className="text-sky-600 hover:underline dark:text-sky-300">agentos.sh</a>
              </li>
              <li>
                <a href="https://frame.dev" target="_blank" rel="noreferrer" className="text-sky-600 hover:underline dark:text-sky-300">frame.dev</a>
              </li>
              <li>
                <a href="https://vca.chat" target="_blank" rel="noreferrer" className="text-sky-600 hover:underline dark:text-sky-300">vca.chat · AgentOS Marketplace</a>
              </li>
              <li>
                <a href="https://github.com/framerslab/agentos" target="_blank" rel="noreferrer" className="text-sky-600 hover:underline dark:text-sky-300">github.com/framerslab/agentos</a>
              </li>
            </ul>
            <div className="mt-2 flex flex-wrap gap-2">
              <a href="https://github.com/framerslab/agentos" target="_blank" rel="noreferrer">
                <img alt="GitHub stars" src="https://img.shields.io/github/stars/framersai/agentos?style=social" />
              </a>
              <a href="https://github.com/framerslab/agentos/fork" target="_blank" rel="noreferrer">
                <img alt="GitHub forks" src="https://img.shields.io/github/forks/framersai/agentos?style=social" />
              </a>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-slate-900/40">
            <p className="text-xs uppercase tracking-[0.35em] text-slate-500 dark:text-slate-400">Packages</p>
            <ul className="mt-2 space-y-1 text-sm">
              <li>
                <a href="https://www.npmjs.com/package/@framers/agentos" target="_blank" rel="noreferrer" className="text-sky-600 hover:underline dark:text-sky-300">@framers/agentos</a>
              </li>
              <li>
                <a href="https://www.npmjs.com/package/@framers/sql-storage-adapter" target="_blank" rel="noreferrer" className="text-sky-600 hover:underline dark:text-sky-300">@framers/sql-storage-adapter</a>
              </li>
            </ul>
          </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-slate-900/40">
          <p className="text-xs uppercase tracking-[0.35em] text-slate-500 dark:text-slate-400">Team</p>
          <p className="mt-2 text-sm">Contact: <a href="mailto:team@frame.dev" className="text-sky-600 hover:underline dark:text-sky-300">team@frame.dev</a></p>
        </div>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400">
          Logos and names are property of their respective owners. Links open in a new tab.
        </p>
      </div>
    </section>
  );
}
