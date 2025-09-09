const vscode = require('vscode');
const path = require('path');

class FileNode extends vscode.TreeItem {
    constructor(label, collapsibleState, fullPath, isFolder = false) {
        super(label, collapsibleState);
        this.fullPath = fullPath;
        this.isFolder = isFolder;

        // Show different icons for file/folder
        this.iconPath = isFolder
            ? new vscode.ThemeIcon('folder')
            : new vscode.ThemeIcon('file');

        // If it's a file, allow opening
        if (!isFolder) {
            this.command = {
                command: 'aixExplorer.openFile',
                title: 'Open File',
                arguments: [this.fullPath]
            };
        }
    }
}


class AixExplorerProvider  {
    constructor(getServersCallback) {
        // Instead of a static list, we use a callback that returns current servers
        this.getServers = getServersCallback;
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._emitter.event;

    }

    getTreeItem(element) {
        return element;
    }

    // openFile(file,e) {
        
    // }

    async getChildren(element) {
        if (!element) {
            // Root level → dynamically get server list
            const servers = await this.getServers(); // returns [{name, folder, isRemote}, ...]
            return servers.map(server =>
                new FileNode(
                    server.name,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    server.folder, // the local cache folder for this server
                    true // it's a folder
                )
            );
        }

        if (element.isFolder) {
            // Same as before: read cached folder contents
            const fs = require('fs');
            const children = await fs.promises.readdir(element.fullPath, { withFileTypes: true });
            return children.map(child =>
                new FileNode(
                    child.name,
                    child.isDirectory() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                    path.join(element.fullPath, child.name),
                    child.isDirectory()
                )
            );
        }

        return [];
    }
    refresh() {
    this._emitter.fire(); // tells VSCode to call getChildren() again
}
}



module.exports = {AixExplorerProvider};