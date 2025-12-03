# remote-rsync README
A replacement for the remote-ssh like on linux to be on unix.It doesn't have all that capabilities as in linux but works well like vim, but better editing and can use various open source tools which are there in vscode while editing code files.

## Features
1) It can help you edit your remote files.
2) You can use various AI tools on that file which you are gonna edit like inline code suggestion,copilot etc.
3) You can peek through various macros and their definitions.
4) You can open a new file typing code <filename>.
5) Basically you can do all things  a vim in unix system can do but with some more better features.
6) The best thing about it is it's usability.

For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

## Requirements
Your unix system should have some of these pacakges:
1) sed
2) rsync
3) ssh
4) bash

That is enough for this extension to work on your system to access remote files.


## Extension Settings

Include if your extension adds any VS Code settings through the `contributes.configuration` extension point.

For example:

This extension contributes the following settings:

* `myExtension.enable`: Enable/disable this extension.
* `myExtension.thing`: Set to `blah` to do something.

## Known Issues
It has some issues:
1) Currently it doesn't have context of the system on which you are working on.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.

---

## Working with Markdown

You can author your README using Visual Studio Code.  Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux)
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux)
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
