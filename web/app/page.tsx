import Install from "./components/install";
import SiteHeader from "./components/site-header";
import Usage from "./components/usage";
import VideoPlayer from "./components/video-player";
import { GithubMark } from "./components/icons";

export default function Home() {
  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-[880px] px-5 sm:px-8">
        {/* the left rail is an indent now rather than an index — with one
            section left there is no sequence to number */}
        <div className="grid grid-cols-1 gap-8 py-16 sm:grid-cols-[64px_1fr] sm:py-24">
          <div className="hidden sm:block" aria-hidden />
          <div className="min-w-0">
            <h1 className="text-[20px] leading-[1.22] font-medium tracking-[-0.02em] text-text sm:text-[26px] sm:whitespace-nowrap">
              VS Code inside your{" "}
              <span className="keyword">
                terminal
                <span className="caret" aria-hidden />
              </span>
            </h1>

            <div className="mt-9 w-[440px] max-w-full">
              <Install />
            </div>
          </div>
        </div>

        <div className="rule" aria-hidden />

        {/* the demo sits in the same column as the text, indent and all */}
        <div className="grid grid-cols-1 gap-8 py-12 sm:grid-cols-[64px_1fr] sm:py-14">
          <div className="hidden sm:block" aria-hidden />
          <VideoPlayer
            dark={{
              src: "/demo-dark.mp4",
              poster: "/demo-dark-poster.webp",
              durationHint: 7.07,
            }}
            light={{
              src: "/demo-light.mp4",
              poster: "/demo-light-poster.webp",
              durationHint: 8.23,
            }}
            ratio="1600 / 1076"
          />
        </div>

        <div className="rule" aria-hidden />

        <div className="grid grid-cols-1 gap-6 pt-12 sm:grid-cols-[64px_1fr] sm:gap-8 sm:pt-14">
          <div className="hidden sm:block" aria-hidden />
          <Usage />
        </div>

        <div className="rule mt-12 sm:mt-14" aria-hidden />

        <div className="grid grid-cols-1 gap-6 pt-12 sm:grid-cols-[64px_1fr] sm:gap-8 sm:pt-14">
          <div className="hidden sm:block" aria-hidden />
          <div className="min-w-0">
            <h2 className="text-[15px] font-medium tracking-[-0.01em] text-text">
              How does it work?
            </h2>
            <p className="mt-3 max-w-[560px] text-[13px] leading-[1.75] text-muted">
              terminal-code combines{" "}
              <a
                href="https://github.com/microsoft/vscode"
                target="_blank"
                rel="noreferrer"
                className="text-text2 underline decoration-border underline-offset-[3px] transition-colors hover:text-ok hover:decoration-ok/50"
              >
                VS Code
              </a>{" "}
              (served to the browser by its own{" "}
              <span className="font-mono">code serve-web</span>) and{" "}
              <a
                href="https://github.com/zenbu-labs/terminal-browser"
                target="_blank"
                rel="noreferrer"
                className="text-text2 underline decoration-border underline-offset-[3px] transition-colors hover:text-ok hover:decoration-ok/50"
              >
                terminal-browser
              </a>{" "}
              (a browser in the terminal) to bring VS Code to the terminal. You
              should look into these projects for more details!
            </p>
            <p className="mt-3 max-w-[560px] text-[13px] leading-[1.75] text-muted">
              <a
                href="https://github.com/zenbu-labs/terminal-code"
                target="_blank"
                rel="noreferrer"
                className="text-text2 underline decoration-border underline-offset-[3px] transition-colors hover:text-ok hover:decoration-ok/50"
              >
                terminal-code
              </a>{" "}
              is also open source if you want to learn more.
            </p>
          </div>
        </div>

        <footer className="rule mt-14 flex items-center justify-between py-8 sm:mt-20">
          <span className="font-mono text-[11px] text-faint">
            © 2026 Zenbu Labs
          </span>
          <span className="flex items-center gap-5">
            <a
              href="mailto:rob@zenbu.dev"
              className="font-mono text-[11px] text-faint transition-colors hover:text-text2"
            >
              contact
            </a>
            <a
              href="https://github.com/zenbu-labs/terminal-code"
              target="_blank"
              rel="noreferrer"
              aria-label="terminal-code on GitHub"
              title="zenbu-labs/tode"
              className="flex items-center text-faint transition-colors hover:text-text2"
            >
              <GithubMark size={14} />
            </a>
          </span>
        </footer>
      </main>
    </>
  );
}
