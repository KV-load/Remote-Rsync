
const vscode = require('vscode');
const fs = require('fs');
const Client = require('ssh2-sftp-client')
const path = require('path');
const util = require('util');

const exec = util.promisify(require('child_process').exec);
const spawn = require('child_process').spawn;





class AixFSProvider {
    constructor(GetServers) {
        // this.aixUser = aixUser;
        // this.aixHost = aixHost;
        // this.keyPath = keyPath;
        // this.tempDir = temp_dir || path.join(require('os').tmpdir(), 'aixfs');
        // this._emitter = new vscode.EventEmitter();
        // this.onDidChangeFile = this._emitter.event;
        // this._lastModified = new Map();
        // this.sftp = new Client();

        // // lazy connect
        // this._connectPromise = this.sftp.connect({
        //     host: this.aixHost,
        //     username: this.aixUser,
        //     privateKey: fs.readFileSync(this.keyPath)
        // }).catch(err => {
        //     vscode.window.showErrorMessage(`SFTP connect failed: ${err.message}`);
        // });
        this.getServers = GetServers;
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeFile = this._emitter.event;
    }

    async readFile(uri) {
        // await this._connectPromise;
        const Servers = await this.getServers();
        const hostname = uri.authority;

        const remote_server = Servers.get(hostname);
        await remote_server._connectPromise;

        const remotePath = uri.path;
        const preview_localPath = path.join(require('os').tmpdir(), path.basename(remotePath) + 'view');
        const localPath = path.join(remote_server.TEMP_DIR, path.basename(remotePath));

        vscode.window.setStatusBarMessage(`Reading file from AIX: ${remotePath}`, 2000);

        try {
            await remote_server.sftp.fastGet(remotePath, preview_localPath);
            fs.copyFileSync(preview_localPath, localPath);

            // Save mtime
            const stat = await remote_server.sftp.stat(remotePath);
            remote_server._lastModified.set(remotePath, stat.modifyTime);

            return fs.readFileSync(preview_localPath); // Buffer for VS Code API
        }  
         catch (err) {
        // If file not found, return empty
        if (err.code === 2 || /No such file/i.test(err.message)) {
            fs.writeFileSync(preview_localPath, "");
            return Buffer.from("");
        }

        try {
            // Try resolving symlinks
            let stats = await remote_server.sftp.stat(remotePath);
            let new_remotePath = remotePath;

            if ((stats.mode & 0o170000) !== 0o100000) {
                console.log(`Resolving ${remotePath} (not a regular file)`);
                new_remotePath = await remote_server.sftp.realPath(remotePath);
                stats = await remote_server.sftp.stat(new_remotePath);
            }

            if ((stats.mode & 0o170000) === 0o100000) {
                // Regular file → fastGet
                await remote_server.sftp.fastGet(new_remotePath, preview_localPath);
                fs.copyFileSync(preview_localPath, localPath);
                remote_server._lastModified.set(remotePath, stats.modifyTime);
                return fs.readFileSync(preview_localPath);
            } else {
                // 🚨 Not a regular file, final fallback → use SSH cat
                console.log(`Falling back to remote cat for ${remotePath}`);
                const { stdout, stderr } = await exec(
                    `ssh ${remote_server.AIX_USER}@${remote_server.AIX_HOST} "cat ${new_remotePath}"`
                );

                if (stderr && stderr.trim()) {
                    throw new Error(`cat failed: ${stderr}`);
                }
                fs.writeFileSync(preview_localPath, stdout);
                fs.copyFileSync(preview_localPath, localPath);
                return fs.readFileSync(preview_localPath);
            }
        } catch (innerErr) {
            console.error(`Failed to resolve/fetch ${remotePath}: ${innerErr.message}`);
            throw new Error(`readFile failed for ${remotePath}: ${innerErr.message}`);
        }
    }
}

    async writeFile(uri, content, options) {
        const hostname = uri.authority;
        const Servers = await this.getServers();

        const remote_server = Servers.get(hostname);
        await remote_server._connectPromise;

        await remote_server._connectPromise;
        const remotePath = uri.path;
        const tmpFile = path.join(remote_server.TEMP_DIR, path.basename(remotePath));
        const preview_tmpFile = path.join(require('os').tmpdir(), path.basename(remotePath) + 'view');

        fs.writeFileSync(preview_tmpFile, content);

        try {
            // Use rsync instead of sftp
            await this._rsyncPut(preview_tmpFile, remotePath,remote_server);

            fs.copyFileSync(preview_tmpFile, tmpFile);

            const stat = await remote_server.sftp.stat(remotePath);
            remote_server._lastModified.set(remotePath, stat.modifyTime);

            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        } catch (err) {
            throw new Error(`writeFile failed for ${remotePath}: ${err.message}`);
        }
}

    // Helper
async _rsyncPut(localPath, remotePath,remote_server) {
    return new Promise((resolve, reject) => {
        const cmd = 'rsync';
        const args = ['-z', localPath, `${remote_server.AIX_USER}@${remote_server.AIX_HOST}:${remotePath}`];

        const child = spawn(cmd, args);

        let stderr = '';
        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`rsync exited with code ${code}: ${stderr}`));
            }
            resolve();
        });
    });
}
    watch(uri, options) {
        const remotePath = uri.path;
        const hostname = uri.authority;
       

        const interval = setInterval(async () => {
            try {
                const Servers = await this.getServers();
        

                const remote_server = Servers.get(hostname);
                await remote_server._connectPromise;

                const stat = await remote_server.sftp.stat(remotePath);
                const mtime = stat.modifyTime;
                const lastMtime = remote_server._lastModified.get(remotePath);

                if (!lastMtime) {
                    remote_server._lastModified.set(remotePath, mtime);
                } else if (mtime !== lastMtime) {
                    remote_server._lastModified.set(remotePath, mtime);

                    // Trigger change event, consumer will re-read
                    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
                }
            } catch (err) {
                console.error(`Watch error for ${remotePath}: ${err.message}`);
            }
        }, 2000); // faster than before (2s instead of 3s)

        return new vscode.Disposable(() => clearInterval(interval));
    }

    async stat(uri) {
    const Servers = await this.getServers();

    const hostname = uri.authority;
    const remote_server = Servers.get(hostname);
    const stats = await remote_server.sftp.stat(uri.path);

    return {
        type: vscode.FileType.File,
        ctime: stats.accessTime * 1000,
        mtime: stats.modifyTime * 1000,
        size: stats.size
    };
}
    refresh() {
        this._emitter.fire(); // a bit hacky, but works well
    }
    readDirectory() { return []; }
    createDirectory() {}
    delete() {}
    rename() {}
}




class FileNode extends vscode.TreeItem {
    constructor(label, collapsibleState, fullPath, isFolder = false) {
        super(label, collapsibleState);
        this.fullPath = fullPath;
        this.isFolder = isFolder;

        this.resourceUri = vscode.Uri.file(fullPath); // now getting all local vscode features

        // Override only if you want to force a special icon
        if (isFolder) {
            this.iconPath = new vscode.ThemeIcon('folder');
        }

        // If it's a file, allow opening
        if (!isFolder) {
            this.command = {
                command: 'openFile',
                title: 'Open File',
                arguments: [this.fullPath]
            };
        }
    }
}


class AixExplorerProvider  {
    constructor(getServersCallback,Remote_server) {
        // Instead of a static list, we use a callback that returns current servers
        this.getServers = getServersCallback;
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._emitter.event;
        this.server = Remote_server;

    }

    getTreeItem(element) {
        return element;
    }

  async openFile(file, e) {
    const localPath = file.resourceUri.fsPath;

    if (fs.existsSync(localPath)) {
        // Open from local cache first
        const doc = await vscode.workspace.openTextDocument(localPath);
        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    } else {
        // Open from remote via your custom provider
        const remotePath = this.server.localtoRemote.get(file.label);
        const uri = vscode.Uri.from({
            scheme: "aix",
            authority: this.server.AIX_HOST,
            path: remotePath
        });
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    }
}

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



module.exports = {AixExplorerProvider,AixFSProvider};