import Link from "next/link";

import { GithubMark } from "./icons";

export default function SiteHeader() {
  return (
    <header className="border-b border-border-soft">
      <div className="mx-auto flex h-[52px] max-w-[880px] items-center justify-between px-5 sm:px-8">
        <Link
          href="/"
          className="flex items-center text-[14px] tracking-tight text-text"
        >
          terminal-code
        </Link>
        <a
          href="https://github.com/zenbu-labs/terminal-code"
          target="_blank"
          rel="noreferrer"
          aria-label="terminal-code on GitHub"
          title="zenbu-labs/terminal-code"
          className="flex items-center text-faint transition-colors hover:text-text"
        >
          <GithubMark />
        </a>
      </div>
    </header>
  );
}
