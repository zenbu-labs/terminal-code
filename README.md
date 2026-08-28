# terminal-code


VS Code inside your terminal



https://github.com/user-attachments/assets/4ba0d434-896a-4ab3-9c91-5d351dacee08


### Install (macOS & Linux):

```bash
curl -fsSL https://tode.sh/install | bash
```

### Usage
```
Usage: tode [path...] [options]
       tode --<command>

  tode                  Open the folder in the current working directory
  tode <folder>         Open the specified folder
  tode <file>           Open the specified file


Options:
  -g, --goto <f:l:c>    Open a file at a line and column
  -a, --add <folder>    Add a folder to the active workspace
  -n, --new-window      Open a new pane even for a file
  -w, --wait            Wait until the file is closed again
  -d, --diff <a> <b>    Compare two files
  -r, --reuse-window    Open folder in this window rather than a new pane
  --install-extension   Install an extension by id or vsix path
  --uninstall-extension Remove an extension
  --list-extensions     List installed extensions
  --split <direction>   Open in a new pane: right, left, down, up
  --size <fraction>     The % a new split will take up (0.2 to 0.95)
  --timing              Report how long each stage of this open took
  --review              Open on the source control panel
  --ssh <user@host>     Run terminal-code on an ssh server

Commands, each as the first argument:
  --shortcut-setup      Resolve shortcut conflicts between terminal-code and the current terminal
  --timing              Profile terminal-code launch
  --import [editor]     Bring settings, keybindings, snippets and extensions
                        over from vscode compatible editors
  --theme [file]        Set editor theme
  --serve [path]        Start code server and print its url
  --skill               An agent skill to assist with modifying terminal-code
  --upgrade [--check]   Upgrade terminal-code to the latest version
  --shutdown            Stop all terminal-code activities
  --uninstall [--yes]   Remove all terminal-code data from this machine

```

### How does it work?

terminal-code combines [terminal-browser](https://github.com/zenbu-labs/terminal-browser) (a browser in the terminal) and [VS Code](https://github.com/microsoft/vscode)'s own web server — the `code serve-web` that ships with the official `code` CLI — to bring the real VS Code to the terminal. You should look into these projects for more details!



### Shortcuts

Your terminal and terminal-code will likely conflict on important shortcuts, meaning sometimes terminal-code will never even receive your key press. To resolve
shortcut conflicts you can run `tode --shortcut-setup`, and you will be placed into an interactive wizard that lets you change terminal or terminal-code shortcuts
so they no longer conflict


### SSH

The recommended way to use terminal-code over ssh is running `tode --ssh <ssh arguments>` on your local machine.

The alternative is running `tode` directly on the machine you are shh'd into. This will work, but
requires:
- every single frame drawn by vscode to be sent over the network
- all user input to be sent over the network before vscode can react
- misses out some [extra optimizations](https://sw.kovidgoyal.net/kitty/graphics-protocol/#local-client)

`tode --ssh` improves on this by running only the backend of vscode on the remote machine. The frontend is still running locally on your device, so vscode is able to respond to interactions ~instantly. Any network requests will get proxied over the ssh connection.

### Windows

terminal-code depends on a modern terminal feature ([the kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)) that not many terminals on Windows support. There are projects attempting to bring this capability to terminals on Windows that you can try at your own risk:
- https://github.com/ibuildthecloud/winterm-ghostty

Even with a compatible terminal, terminal-code does not have an official windows build. But, it's possible to install the linux version of terminal-code inside [WSL](https://learn.microsoft.com/en-us/windows/wsl/install), which is the final piece needed to run terminal-code on Windows. Please file an issue if you are eager for a more official solution
