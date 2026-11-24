/* straight from `terminal-code --help` — enough to go from installed to editing without
   opening the docs. Rows rather than a boxed block, so it reads as reference
   material and not as a second install widget. */

const LINES = [
  { cmd: "terminal-code", note: "opens the current folder" },
  { cmd: "terminal-code <folder>", note: "opens that folder" },
  { cmd: "terminal-code <file>", note: "opens that file" },
  { cmd: "terminal-code --ssh <ssh args>", note: "run terminal-code on an ssh server" },
  { cmd: "terminal-code --goto <f:l:c>", note: "opens a file at a line and column" },
  { cmd: "terminal-code --diff <a> <b>", note: "compares two files" },
  { cmd: "terminal-code --split right", note: "opens terminal-code in a terminal split pane to the right" },
  { cmd: "terminal-code --review", note: "opens on the source control panel" },
  { cmd: "terminal-code --import", note: "imports settings, keybindings, snippets and extensions from vscode compatible editors" },
  { cmd: "terminal-code --shortcut-setup", note: "resolves shortcut conflicts between terminal-code and the current terminal" },
  { cmd: "terminal-code --enable-local-rendering-over-ssh", note: "renders terminal-code on your own machine when you run it over ssh, must be enabled on both machines" },
  { cmd: "terminal-code --upgrade", note: "upgrades terminal-code to the latest version" },
];

export default function Usage() {
  return (
    <div className="divide-y divide-border-soft border-y border-border-soft">
      {LINES.map((l) => (
        <div
          key={l.cmd}
          className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-6"
        >
          <code className="font-mono text-[12px] whitespace-nowrap text-text2 sm:w-[340px] sm:shrink-0">
            {/* the binary name reads as a prompt highlight, the way a shell
                with syntax colouring would set it */}
            <span className="text-ok">{l.cmd.split(" ")[0]}</span>
            {l.cmd.includes(" ") ? l.cmd.slice(l.cmd.indexOf(" ")) : ""}
          </code>
          <span className="text-[12.5px] text-muted">{l.note}</span>
        </div>
      ))}
    </div>
  );
}
