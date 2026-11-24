# terminal-code


VS Code inside your terminal



https://github.com/user-attachments/assets/4ba0d434-896a-4ab3-9c91-5d351dacee08


### Install (macOS & Linux):

```bash
curl -fsSL https://tode.sh/install | bash
```

### Usage
```
Usage: terminal-code [path...] [options]
       terminal-code --<command>

  terminal-code           Open the folder in the current working directory
  terminal-code <folder>  Open the specified folder
  terminal-code <file>    Open the specified file

  tode is the same command under its old name.


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
  --enable-transparency Make the editor transparent
  --disable-transparency Make the editor opaque again
  --enable-local-rendering-over-ssh [--allow-peer <device>]
                        Render terminal-code on your own machine when it
                        runs over ssh; run it on the server and locally
  --disable-local-rendering-over-ssh
                        Turn local rendering over ssh off on this machine
  --setup-ssh [user@host]
                        Connect to a server that can't reach this machine,
                        so terminal-code there renders here
  --local-rendering-doctor
                        Explain the local rendering connection
  --serve [path]        Start code server and print its url
  --skill               An agent skill to assist with modifying terminal-code
  --upgrade [--check]   Upgrade terminal-code to the latest version
  --shutdown            Stop all terminal-code activities
  --uninstall [--yes]   Remove all terminal-code data from this machine

```

### How does it work?

terminal-code combines [terminal-browser](https://github.com/zenbu-labs/terminal-browser) (a browser in the terminal) and [code-server](https://github.com/coder/code-server) (VS Code in the browser) to bring VS Code to the terminal. You should look into these projects for more details!



### Shortcuts

Your terminal and terminal-code will likely conflict on important shortcuts, meaning sometimes terminal-code will never even receive your key press. To resolve
shortcut conflicts you can run `terminal-code --shortcut-setup`, and you will be placed into an interactive wizard that lets you change terminal or terminal-code shortcuts
so they no longer conflict



### SSH

The recommended way to use terminal-code over ssh is running `terminal-code --ssh <ssh arguments>` on your local machine.

The alternative is running `terminal-code` directly on the machine you are shh'd into. This will work, but
requires:
- every single frame drawn by vscode to be sent over the network
- all user input to be sent over the network before vscode can react
- misses out some [extra optimizations](https://sw.kovidgoyal.net/kitty/graphics-protocol/#local-client)

`terminal-code --ssh` improves on this by running only the backend of vscode on the remote machine. The frontend is still running locally on your device, so vscode is able to respond to interactions ~instantly. Any network requests will get proxied over the ssh connection.

<!-- fixme: placeholder copy -->
#### Local rendering over ssh

If you'd rather run `terminal-code` inside the ssh session itself, it can still render on your own machine. Run `terminal-code --enable-local-rendering-over-ssh` on the server and on your local machine. terminal-code on the server then renders on your local machine, which reaches the server's code-server through the same connection, so frames never cross the network.

- The server finds your machine through the ssh connection's client address and connects to it over your tailnet. Your machine only listens on its tailnet addresses, and only accepts your own devices (as Tailscale identifies them). `--allow-peer <device>` admits another device, such as a tagged server.
- If the server can't reach your machine, run `terminal-code --setup-ssh <user@server>` on your machine instead. It opens an ssh connection to the server and a socket there that only your user can use, for as long as that connection lasts.
- If local rendering fails, terminal-code renders on the server as before, and the editor tells you why. `terminal-code --local-rendering-doctor` explains the connection in detail.

`tode` remains available as the old name of the `terminal-code` command.

### Windows

terminal-code depends on a modern terminal feature ([the kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)) that not many terminals on Windows support. There are projects attempting to bring this capability to terminals on Windows that you can try at your own risk:
- https://github.com/ibuildthecloud/winterm-ghostty

Even with a compatible terminal, terminal-code does not have an official windows build. But, it's possible to install the linux version of terminal-code inside [WSL](https://learn.microsoft.com/en-us/windows/wsl/install), which is the final piece needed to run terminal-code on Windows. Please file an issue if you are eager for a more official solution
