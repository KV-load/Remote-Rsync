

const vscode = require('vscode');
const fs = require('fs');
const Client = require('ssh2-sftp-client')
const path = require('path');
const util = require('util');

const exec = util.promisify(require('child_process').exec);
const spawn = require('child_process').spawn;

//function to get the dir name from the file_name

 
async function filetodirname(localPath) {
    let temp_str ="";
    let server_name = "";

    for(let i=0;i<localPath.length-1;i++){
    console.log(temp_str)

        if(localPath[i]!=="/"){
            temp_str+=localPath[i];
        }
        else{
            if(temp_str.length>0 && temp_str.includes("temp_"))
            {
                server_name = temp_str.split('_')[1];
                break;
            }
            temp_str="";
        }
    }


return server_name;

}


async function hash_path(remotePath,Remote_server)
{
    const base = path.basename(remotePath); 

    let parent = path.dirname(remotePath); // e.g. project1

    // console.log("hash_path",base,"  parent.  ", parent);

    if(parent==="/")
    {
        parent="HOME";
    }

    let local_dirname = '';

    if(Remote_server.localfoldertoRemote.get(parent)){ // here I am checking if the parent directory already has a local folder created for it or not.
        local_dirname = Remote_server.localfoldertoRemote.get(parent);
    }
    else{
        console.log("Creating new folder for ",parent," inside ",Remote_server.TEMP_DIR);


        local_dirname = path.join(Remote_server.TEMP_DIR,path.basename(parent));
        local_dirname = local_dirname + "@0";

        // to check if the folder already exists then just create a one cntr_more;
        let cnt = parseInt(local_dirname.split("@")[1]);
        const dirname =  local_dirname.split("@")[0];

        while(fs.existsSync(local_dirname))
        {
        cnt++;
        local_dirname = `${dirname}@${cnt}`;
        }
       fs.mkdirSync(local_dirname, { recursive: true });

        console.log(local_dirname);
        Remote_server.localfoldertoRemote.set(parent,local_dirname);
    }



    

 
    // let old_parent = "";
    // if(Remote_server.localtoRemote.get(base))
    // {
    //     old_parent = Remote_server.localtoRemote.get(base);
    //     old_parent = path.dirname(old_parent);
    //     if(parent==old_parent)
    //     {

    //     }
    // }

    

    
    const local_path = path.join(local_dirname, base);


        

    //creating directory inside it saving the files with same name 

    return local_path;
}


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
        // await remote_server._connectPromise;

        const remotePath = uri.path;
        const preview_localPath = path.join(require('os').tmpdir(), path.basename(remotePath) + 'view');
        const localPath = await hash_path(remotePath,remote_server);


        const sftp = remote_server.sftp;

    try {

    console.log("Path read is " + localPath);
        
       await this.streamfetch(sftp, remotePath, localPath);

        // Save mtime
        const stat = await this.stat(remotePath,remote_server);
        remote_server._lastModified.set(remotePath, stat.modifyTime);
        remote_server._lastModified_size.set(remotePath, stat.size);

        // ✅ VS Code gets a single clean buffer load
        return fs.readFileSync(localPath);

    } 
         catch (err) {
        // If file not found, return empty
        if (err.code === 2 || /No such file/i.test(err.message) || err.message.includes("Unable to read file")) {
            
            // fs.writeFileSync(preview_localPath, "");  
            fs.writeFileSync(localPath,"");

            return Buffer.from("");
        }
        try {
            // Try resolving symlinks
            let stats = await this.stat(remotePath,remote_server);
            let new_remotePath = remotePath;

            if ((stats.mode & 0o170000) !== 0o100000) {
                console.log(`Resolving ${remotePath} (not a regular file)`);
                new_remotePath = await remote_server.sftp.realPath(remotePath);
                stats = await this.stat(new_remotePath,remote_server);
            }

            if ((stats.mode & 0o170000) === 0o100000) {
                // Regular file → fastGet
                await this.streamfetch(sftp, new_remotePath, localPath);

                // await remote_server.sftp.fastGet(new_remotePath, localPath);  You download directly into localPath (the file your editor buffer is tied to, if you opened file://...).
                                                                                //VS Code monitors local files with the OS file watcher.
                                                                                //When that file changes on disk → VS Code sees it as an external change → it closes/reloads the whole buffer → flicker, "file reloaded" message, cursor reset, etc.
         
                remote_server._lastModified.set(remotePath, stats.modifyTime);
                remote_server._lastModified_size.set(remotePath, stats.size);
                return fs.readFileSync(localPath);

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

                return fs.readFileSync(preview_localPath); // Buffer just changed not whole file hence smooth transition instead of that local_path
            }
        } catch (innerErr) {
            console.error(`Failed to resolve/fetch ${remotePath}: ${innerErr.message}`);
            throw new Error(`readFile failed for ${remotePath}: ${innerErr.message}`);
        }
    }
}

async streamfetch(sftp, remotePath, localPath) {
    vscode.window.setStatusBarMessage(`📡 Streaming file from AIX: ${remotePath}`, 2000);

    // open in append mode so it doesn’t conflict with VSCode buffer
    const writeStream = fs.createWriteStream(localPath, {
        flags: 'w',    // append mode instead of overwrite
        encoding: 'utf8',
        autoClose: true
    });

    const readStream = await sftp.createReadStream(remotePath);

    await new Promise((resolve, reject) => {
        readStream
            .on('data', chunk => {
                // write smoothly; pause/resume if needed
                if (!writeStream.write(chunk)) {
                    readStream.pause();
                    writeStream.once('drain', () => readStream.resume());
                }
            })
            .once('end', async () => {
                writeStream.end();
                vscode.window.setStatusBarMessage(`✅ Finished streaming ${remotePath}`, 2000);
                try {
                    // 🔄 Force reload the open document
                    const doc = await vscode.workspace.openTextDocument(localPath);
                    await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
                } catch (err) {
                    console.error('Failed to reload:', err);
                }
                resolve();
            })
            .once('error', err => {
                writeStream.destroy();
                vscode.window.showErrorMessage(`Stream error: ${err.message}`);
                reject(err);
            });
    });
}


    async writeFile(uri, content, options) {
        const hostname = uri.authority;
        const Servers = await this.getServers();

        const remote_server = Servers.get(hostname);
        // await remote_server._connectPromise;

        const remotePath = uri.path;
        const tmpFile = await hash_path(remotePath,remote_server);
        const preview_tmpFile = path.join(require('os').tmpdir(), path.basename(remotePath) + 'view');

        // fs.writeFileSync(preview_tmpFile, content);

        fs.writeFileSync(tmpFile, content);

        try {
            // Use rsync instead of sftp
            // await this._rsyncPut(preview_tmpFile, remotePath,remote_server);

            // fs.copyFileSync(preview_tmpFile, tmpFile);

            await this._rsyncPut(tmpFile, remotePath,remote_server);

            const stat = await this.stat(remotePath,remote_server);
            remote_server._lastModified.set(remotePath, stat.modifyTime);
            remote_server._lastModified_size.set(remotePath, stat.size);

            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        } catch (err) {
            throw new Error(`writeFile failed for ${remotePath}: ${err.message}`);
        }
}

    // Helper
async _rsyncPut(localPath, remotePath, remote_server) {
    return new Promise((resolve, reject) => {
        // First, check rsync path

        let rsyncPath = remote_server.rsync_path || '';
            // Now run rsync
            const args = ["-z", localPath,`--rsync-path=${rsyncPath}`,`${remote_server.AIX_USER}@${remote_server.AIX_HOST}:${remotePath}`];
            const child = spawn("rsync", args);

            let stderr = "";

            // collect all stderr, not just first chunk
            child.stderr.on("data", (data) => {
                stderr += data.toString();
            });

            child.once("close", (code) => {
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
                // await remote_server._connectPromise;

                const stat = await this.stat(remotePath,remote_server);
                const mtime = stat.modifyTime;
                const lastMtime = remote_server._lastModified.get(remotePath);
                const lastsize = remote_server._lastModified_size.get(remotePath);


                // bool to have the trigger event only once when the file is created
                let file_changed = false;

                // check if size has changed
                const size = stat.size;


                  if (!lastMtime) {
                    remote_server._lastModified.set(remotePath, mtime);
                } else if (mtime !== lastMtime ) {
                    remote_server._lastModified.set(remotePath, mtime);
                    file_changed = true;
                    // Trigger change event, consumer will re-read
                    this.readFile(uri);

                }

                if(!lastsize)
                {
                    remote_server._lastModified_size.set(remotePath, size);
                }
                else if(size !== lastsize && !file_changed)
                {
                    file_changed = true;
                    remote_server._lastModified_size.set(remotePath, size);
                    
                    this.readFile(uri);

                }

                if(file_changed)
                {
                    console.log("FIles has changed on AIX:",remotePath);
                }
              
            } catch (err) {
                
                console.error(`Watch error for ${remotePath}: ${err.message}`);
            }
        }, 3000); // faster than before (2s instead of 3s)

        return new vscode.Disposable(() => clearInterval(interval));
    }

    async stat(remote_path,remote_server) {
    
    try{
    const stats = await remote_server.sftp.stat(remote_path);
    

    return {
        type: vscode.FileType.File,
        ctime: stats.accessTime * 1000,
        mtime: stats.modifyTime * 1000,
        size: stats.size
    };
}
catch (err) {
    if (err.code === 2 || /No such file/i.test(err.message)) {
        // Fake stat so VS Code opens the editor

        const {stdout} = await exec(`ssh ${remote_server.AIX_USER}@${remote_server.AIX_HOST} "date +%s"`);

        const remote_time = parseInt(stdout.trim(),10)*1000;
        return {
            type: vscode.FileType.File,
            ctime: remote_time,   // use local time, since remote doesn’t have one
            mtime: remote_time,
            size: 0
        };
    }
    throw err;
}
}
    // refresh() {
    //     this._emitter.fire(); // a bit hacky, but works well
    // }
    readDirectory() { return []; }
    createDirectory() {}
  async delete(uri) {
    // Tell VS Code the file is gone
    this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);

    const Servers = await this.getServers();
        

    const remote_server = Servers.get(uri.authority);

    // Clean up AixFS-internal state if you cached it
    remote_server._lastModified.delete(uri.path);
    remote_server._lastModified_size.delete(uri.path);
}
    rename() {}
}




// class FileNode extends vscode.TreeItem {
//     constructor(label, collapsibleState, fullPath, isFolder = false) {
//         super(label, collapsibleState);
//         this.fullPath = fullPath;
//         this.isFolder = isFolder;

//         this.resourceUri = vscode.Uri.file(fullPath); // now getting all local vscode features

//         // Override only if you want to force a special icon
//         if (isFolder) {
//             this.iconPath = new vscode.ThemeIcon('folder');
//         }

//         // If it's a file, allow opening
//         if (!isFolder) {
//             this.command = {
//                 command: 'OpenFile',
//                 title: 'Open File',
//                 arguments: [this]
//             };
//         }
//     }
// }


// class AixExplorerProvider  {
//     constructor(getServersCallback,AllServers) {
//         // Instead of a static list, we use a callback that returns current servers
//         this.getServers = getServersCallback;
//         this.AllServers = AllServers;
//         this._emitter = new vscode.EventEmitter();
//         this.onDidChangeTreeData = this._emitter.event;

//     }

//     getTreeItem(element) {
//         return element;
//     }

//   async OpenFile(file) {
//     const localPath = file.resourceUri.fsPath;
//     const Servers = await this.AllServers();

//     // vscode.window.showInformationMessage(localPath," ");

    
//     const server_name = await filetodirname(localPath);
//     const remote_server = await Servers.get(server_name); 


//     if (fs.existsSync(localPath)) {
        
//         // Open from local caffche first
//         let doc = await vscode.workspace.openTextDocument(localPath);
//         await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
//         // Open from remote via your custom provider
//         const remotePath = remote_server.localtoRemote.get(file.label);
//         const uri = vscode.Uri.from({
//             scheme: "aix",
//             authority: remote_server.AIX_HOST,
//             path: remotePath
//         });
//          doc = await vscode.workspace.openTextDocument(uri);
//         await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
//     }
// }

//     async getChildren(element) {
//         if (!element) {
//             // Root level → dynamically get server list
//             const servers = await this.getServers(); // returns [{name, folder, isRemote}, ...]
//             return servers.map(server =>
//                 new FileNode(
//                     server.name,
//                     vscode.TreeItemCollapsibleState.Collapsed,
//                     server.folder, // the local cache folder for this server
//                     true // it's a folder
//                 )
//             );
//         }

//         if (element.isFolder) {
//             // Same as before: read cached folder contents
//             const fs = require('fs');
//             const children = await fs.promises.readdir(element.fullPath, { withFileTypes: true });
//             return children.map(child =>
//                 new FileNode(
//                     child.name,
//                     child.isDirectory() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
//                     path.join(element.fullPath, child.name),
//                     child.isDirectory()
//                 )
//             );
//         }

//         return [];
//     }
//     refresh() {
//     this._emitter.fire(); // tells VSCode to call getChildren() again
// }
// }

// class AIXTimeline
// {
//    constructor(GetAllServers)
//    {
//        this.GetAllServers = GetAllServers;
//    }

//    async provideTimeline(uri, options, token) {
//         // Map aix:// to its cached local path


//         const All_server = await this.GetAllServers();


//         const host = uri.authority;

//         const temp_dir = All_server.get(host).TEMP_DIR;

//         const remote_path = uri.path;

//         remote_path.split("/");
//         const local_path = path.join(temp_dir,remote_path[remote_path.length-1]);

//         const localUri = vscode.Uri.file(local_path);

//         // Ask VS Code’s built-in timeline providers to give us history
//         const timeline = await vscode.commands.executeCommand(
//             "vscode.provideTimeline",
//             localUri,
//             options,
//             token
//         );

//         // Just return that, but pretend it's for aix://
       
//         return {
//              items: timeline?.items ?? [] ,
//         };
//     }
// }





module.exports = {AixFSProvider,hash_path};