const util = require('util');
const exec = util.promisify(require('child_process').exec);
const spawn = require('child_process').spawn;
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const chokidar = require('chokidar');

const {Cscope} = require('./Tools/cscope').Cscope;

const Client = require('ssh2-sftp-client')

// const FileExplorer = require('./Tools/Fileprovider').AixExplorerProvider; //Explorer to manage the files openes from the remote.
const AixFSProvider = require('./Tools/Fileprovider').AixFSProvider;  //FileManager that reads/write the file from th remote.

const hash_path = require('./Tools/Fileprovider').hash_path;
const Parenttodir = require('./Tools/Fileprovider').Parenttodir;



// Handling downtime and restart the servers
class ServerReload {
    constructor(context, restartFunc) {
        this.context = context;
        this.restartFunc = restartFunc;

        // load servers from state
        const stored = context.globalState.get("connectedServers") || [];
        this.servers = stored.map(obj => Server.fromJSON(obj));
    }

    getAll() {
        return this.servers;
    }

    async restartAll() {
        for (const server of this.servers) {
            const value = `${server.AIX_USER}@${server.AIX_HOST}:`;
            try {
                await this.restartFunc(this.context, value, server);
                console.log(`Restarted server ${value}`);
            } catch (err) {
                console.error(`Failed to restart ${value}`, err);
            }
        }
    }

    async add(server) {
        this.servers.push(server);
        await this.context.globalState.update(
            "connectedServers",
            this.servers.map(s => s.toJSON())
        );
    }

    async remove(server) {
        this.servers = this.servers.filter(
            s => !(s.AIX_USER === server.AIX_USER && s.AIX_HOST === server.AIX_HOST)
        );
        await this.context.globalState.update(
            "connectedServers",
            this.servers.map(s => s.toJSON())
        );
    }
}




// Global map to store all server instances
const Servers = new Map();
const Listeners = new Map();
const uriLocaltoRemote = new Map();



// common to all servers
let LOCAL_SYNC_DIR = '';
let mount_dir = '';
let watcherScript = '';
let safeCode ='';
// let Explorer = null;

class Server
{
    constructor(LOCAL_COMMAND_FILE,AIX_HOST,AIX_USER,TEMP_DIR)
    {
        this.LOCAL_COMMAND_FILE = LOCAL_COMMAND_FILE;
        this.AIX_HOST = AIX_HOST;
        this.AIX_USER = AIX_USER;
        this.TEMP_DIR = TEMP_DIR;
        this.rsync_path = 'opt/freeware/bin/rsync';
        this.localtoRemote = new Map();
        this._lastModified = new Map();
        this._lastModified_size = new Map();
        this.sftp = new Client();
        this._connectPromise = null;
        
    }

    updateLocalToRemote(remotePath,fileName)
    {
        this.localtoRemote.set(fileName,remotePath);
        fs.writeFileSync(path.join(this.TEMP_DIR,`${this.AIX_HOST}_files.json`),JSON.stringify(this.localtoRemote));

    }

    SetPort(port)
    {
        this.port = port;
    }

    CreatingTempDir()
    {
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
    }

    Setkeypath(keyPath)
    {
        this.keyPath = keyPath;
        this._connectPromise = this.sftp.connect({
                host: this.AIX_HOST,
                username: this.AIX_USER,
                privateKey: fs.readFileSync(this.keyPath)
            }).catch(err => {
                vscode.window.showErrorMessage(`SFTP connect failed: ${err.message}`);
            });
    }

      // --- NEW: serialize/deserialize helpers ---
    toJSON() {
        return {
            LOCAL_COMMAND_FILE: this.LOCAL_COMMAND_FILE,
            AIX_HOST: this.AIX_HOST,
            AIX_USER: this.AIX_USER,
            TEMP_DIR: this.TEMP_DIR,
            port: this.port,
            keyPath: this.keyPath,
            localtoRemote: [...this.localtoRemote]
        };
    }

    static fromJSON(obj) {
        const s = new Server(obj.LOCAL_COMMAND_FILE, obj.AIX_HOST, obj.AIX_USER, obj.TEMP_DIR);
        s.port = obj.port;
        s.keyPath = obj.keyPath;
        s.localtoRemote = new Map(obj.localtoRemote || []);
        return s;
    }
}




function activate(context) {

    let activeWatcher = null;

    const Explorer_watcher = vscode.workspace.createFileSystemWatcher("**/*");  //for when some local files are deleted

    // //Defining the custom file explorer to be run for the AIX
    // Explorer = new FileExplorer(getServer,AllServers);
    // vscode.window.createTreeView('AIX-explorer', { treeDataProvider: Explorer });

    // Defining the filesystem for the AIX
    const provider = new AixFSProvider(AllServers); // pass your server map
context.subscriptions.push(
  vscode.workspace.registerFileSystemProvider("aix", provider, { isCaseSensitive: true })
);

// // fucntiond for the new epxplorere
// context.subscriptions.push(
//     vscode.commands.registerCommand("OpenFile",async(file)=>
//     {
//         await Explorer.OpenFile(file);
//     }
// )
// );
 // 👇 Register listener globally during activation, not inside a command
    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
        vscode.window.showInformationMessage("Active file changed");

        if (activeWatcher) {
            activeWatcher.dispose();
            activeWatcher = null;
        }

        const local_uri = editor?.document.uri;
        if (!local_uri) return;

        const remote_uri = uriLocaltoRemote.get(local_uri.toString());
        if (!remote_uri) return; // not an AIX-mapped file

        activeWatcher = provider.watch(remote_uri);
    });




    //To defined it globally so that disposable can use .
    const disposable = vscode.commands.registerCommand('remote-rsync.helloWorld', async function () {

        // Creating an reload_Manager instance
        const reloadManager = new ServerReload(context, mountSSHFS);
        
        // Restart all servers on activation
        // reloadManager.restartAll().then(() => {
        //     console.log("All servers restarted");
        // }).catch(err => {
        //     console.error("Failed to restart servers:", err);
        // });
        
       //defining variables here
        let LOCAL_COMMAND_FILE = '';
        let AIX_USER = '';
        let AIX_HOST = '';
        let TEMP_DIR = '';


        mount_dir = vscode.workspace.workspaceFolders[0].uri.fsPath;
        fs.mkdirSync(path.join(mount_dir, '.sshfs'), { recursive: true });
        LOCAL_SYNC_DIR = path.join(mount_dir, '.sshfs');
        


        const logins = loadconfig(context) || [];
        const quickPickItems = [
            ...logins.map(login => ({ label: login })),
            { label: 'Enter new login', alwaysShow: true }
        ];
        const selected = await vscode.window.showQuickPick(quickPickItems,{ placeHolder: 'Select a saved login or enter a new one' ,ignoreFocusOut: true});
        if (!selected) return;

        let value = selected.label;
        if (value === 'Enter new login') {
            const input = await vscode.window.showInputBox({ prompt: 'Enter username@ip_address:/' ,ignoreFocusOut: true});
            if (!input) return;
            value = input;
        }
        
        value = value.trim(); // removing unnecessary spaces
        [AIX_USER, AIX_HOST] = value.split('@');
        TEMP_DIR = path.join(mount_dir, `temp_${AIX_HOST}`);
        LOCAL_COMMAND_FILE = path.join(LOCAL_SYNC_DIR, `command_${AIX_HOST}.txt`);
        


          let Remote_server = new Server(LOCAL_COMMAND_FILE,AIX_HOST,AIX_USER,TEMP_DIR);

        await mountSSHFS(context, value,Remote_server);  //Setting up the server

      
        Servers.set(AIX_HOST, Remote_server);
        // Explorer.refresh();


     
        reloadManager.add(Remote_server); // For reloading of the server when refresh or server is lost
        

        // Register the virtual file system provider for aix:
        // const provider = new AixFSProvider(AIX_USER, AIX_HOST, Remote_server.keyPath,TEMP_DIR);
        // context.subscriptions.push(
        //     vscode.workspace.registerFileSystemProvider(`aix_${AIX_HOST}`, provider, { isCaseSensitive: true })
        // );

        // for the case when we load the files from local temp
// vscode.workspace.onDidOpenTextDocument(async doc => {
//     const filePath = doc.uri.fsPath;

//     // Only intercept TEMP files, not VFS URIs
//     if (filePath.startsWith(TEMP_DIR)) {
//         const fileName = path.basename(filePath);
//         const remotePath = Remote_server.localtoRemote.get(fileName);
//         const vfsUri = vscode.Uri.parse(`aix_${AIX_HOST}:${remotePath}`);

//         // Defer to let VSCode finish opening first
//        setTimeout(async () => {
//     // Find the editor showing this TEMP file
//     const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === filePath);
//     if (editor) {
//         await vscode.window.showTextDocument(editor.document); // make it active
//         await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
//     }

//     // Now open the VFS one
//     const file = await vscode.workspace.openTextDocument(vfsUri);
//     await vscode.window.showTextDocument(file, { preview: true, preserveFocus: false });
// }, 50);

//     }
// });




    //Saving the files which will be done by my custom fs. 
 vscode.workspace.onDidSaveTextDocument(async (event) => {
    const local_uri = event.uri;

    const remote_uri = uriLocaltoRemote.get(local_uri.toString());
    if (!remote_uri) return; // not an AIX-mapped file

    await provider.writeFile(remote_uri, Buffer.from(event.getText()), {
        create: true,
        overwrite: true
    });
});

    //Running watch from custom AIXfs to see any updates from remote to local  

// Opening the file from the local editor

// vscode.workspace.onDidOpenTextDocument((doc) => {
//     const remote_uri = uriLocaltoRemote.get(doc.uri.toString());
//     if (!remote_uri) return;

//     const key = remote_uri.toString();
//     if (!watchers.has(key)) {
//         const watcher = (remote_uri);
//         watchers.set(key, watcher);
//     }
// });


// Closing the listener who's terminal have stopped and they have nothing to do.
vscode.window.onDidCloseTerminal((closedTerm) => {
    const proc = Listeners.get(closedTerm);
    if (proc) {
        proc.kill(); // stop python listener
        Listeners.delete(closedTerm);
    }
});


// Clean up when doc is closed
// vscode.workspace.onDidCloseTextDocument((doc) => {
//     const local_uri = doc.uri;
//     const remote_uri = uriLocaltoRemote.get(local_uri.toString());

//     const key = remote_uri.toString();

//     watchers.get(key)?.dispose();

//     watchers.delete(key);
    
//     // if (doc.uri.toString() === local_uri.toString()) {
//     //     watchers.delete(key);
//     // }
// });

// vscode.window.onDidChangeActiveTextEditor((editor) => {
//     // Dispose previous watcher

//     vscode.window.showInformationMessage("Active file changed");

//     if (activeWatcher) {
//         activeWatcher.dispose();
//         activeWatcher = null;
//     }

//     const local_uri = editor?.document.uri;
//     if (!local_uri) return;

//     const remote_uri = uriLocaltoRemote.get(local_uri.toString());
//     if (!remote_uri) return; // not an AIX-mapped file

//     // Create a new watcher for the currently active file
//     activeWatcher = provider.watch(remote_uri);
// });







        watchCommandFile(Remote_server);
    });



// Local files are deleted and we have to remove the cache of the aixfs
  Explorer_watcher.onDidDelete(uri => {
    if (uriLocaltoRemote.has(uri.toString())) {
        console.log("Local file deleted, clearing cache:", uri.fsPath);
        uriLocaltoRemote.delete(uri.toString());
    }
});

    let disposable2 = vscode.commands.registerCommand("AIX_Terminals", async function() {
    // Turn the Servers map into QuickPick items
    const term_quickPickItems = Array.from(Servers.entries()).map(([host, server]) => ({
        label: host,   // shown in QuickPick
        description: server.TEMP_DIR || '' // optional: show extra info
    }));

    if (term_quickPickItems.length === 0) {
        vscode.window.showErrorMessage("No active servers available");
        return;
    }

    const selected = await vscode.window.showQuickPick(term_quickPickItems, {
        placeHolder: 'Select a connected server',
        ignoreFocusOut: true
    });
    if (!selected) return;

    const chosenHost = selected.label;
    const chosenServer = Servers.get(chosenHost);

    vscode.window.showInformationMessage(chosenHost," ");

    if (!chosenServer) {
        vscode.window.showErrorMessage(`No active server found for ${chosenHost}`);
        return;
    }

    Boot(`${chosenServer.AIX_USER}@${chosenHost}`, chosenServer);
});

    context.subscriptions.push(editorChangeDisposable);
    context.subscriptions.push(disposable);
    context.subscriptions.push(disposable2);
}



// Dynamically assoscaiting the file explorer with the new servers
async function getServer()
{
    return  Array.from(Servers.entries()).map(([hostname,Remote_server])=>
        ( 
            {
                "name": hostname,
                "folder": Remote_server.TEMP_DIR,
            }
        )
    );
}
//Returning all the Server map
async function AllServers()
{
    return Servers;
}


function watchCommandFile(Remote_server) {

    chokidar.watch(Remote_server.LOCAL_COMMAND_FILE).on('change', () => {
        let target = fs.readFileSync(Remote_server.LOCAL_COMMAND_FILE, 'utf8').trim();
        let dir = '';
        let newtarget = '';
        let size = "";
        if(target && target.includes('::'))
        {
            newtarget = target.split('::')[1].trim();
            size  = newtarget.split('@')[1].trim();
            newtarget = newtarget.split('@')[0].trim();
            dir = target.split('::')[0].trim();
            pullFromAix(newtarget,Remote_server);

            dir = target.split('::')[0].trim();
            // Cscope(Remote_server,dir,mount_dir);


        }
        else if (target) {
            newtarget = target.split('@')[0].trim();
            size  = target.split('@')[1].trim();
            pullFromAix(newtarget,Remote_server);
        }
    });
}




async function pullFromAix(remotePath,Remote_server) {
    remotePath = path.posix.normalize(remotePath);
    // Explorer.refresh();

    
    // fs.writeFileSync(path.join(Remote_server.TEMP_DIR,`${Remote_server.AIX_HOST}_files.json`),JSON.stringify(Remote_server.localtoRemote));

      const uri = vscode.Uri.from({
                scheme: "aix",
                authority: Remote_server.AIX_HOST,
                path: remotePath,
            });

        const localFile = await hash_path(remotePath,Remote_server);

        // Remote_server.updateLocalToRemote(path.basename(remotePath),remotePath); 

            let local_uri = vscode.Uri.file(localFile);
            // local_uri = local_uri.with({fragment: `${Date.now()}`});

      uriLocaltoRemote.set(local_uri.toString(),uri);

    await vscode.workspace.openTextDocument(uri);
    const local_file = await vscode.workspace.openTextDocument(local_uri);
    await vscode.window.showTextDocument(local_file, { preview: true, preserveFocus: true });
    
}

function saveConfig(context, login) {
    const configPath = vscode.Uri.joinPath(context.globalStorageUri, 'sshfs-config.json').fsPath;
    let logins = [];
    if (fs.existsSync(configPath)) {
        try { logins = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    }
    if (!logins.includes(login)) logins.push(login);
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(logins, null, 2));
}

function loadconfig(context) {
    const configPath = vscode.Uri.joinPath(context.globalStorageUri, 'sshfs-config.json').fsPath;
    if (fs.existsSync(configPath)) {
        try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return []; }
    }
    return [];
}

function startWatcher(watcherScript,Remote_server) {
    return new Promise((resolve, reject) => {
        fs.chmodSync(watcherScript, "755");

        const pyProc = spawn("python3", [watcherScript,path.join(LOCAL_SYNC_DIR,`command_${Remote_server.AIX_HOST}.txt`)], {
            detached: true,   // allows it to keep running in background
            stdio: ["ignore", "pipe", "pipe"]
        });


        let port;

        pyProc.stdout.on("data", data => {
            const output = data.toString().trim();
            const parsedPort = parseInt(output, 10);

            if (!isNaN(parsedPort)) {
                port = parsedPort;
                console.log("Watcher assigned PORT:", port);
                resolve({ port, process: pyProc });
            }
        });

        pyProc.stderr.on("data", err => {
            console.error(`Watcher error: ${err}`);
        });

        pyProc.on("error", reject);

        // Don't tie Node's lifecycle to the child
        pyProc.unref();
    });
}


function TerminalLoader(userHost,Remote_server,Pyproc)
{
     // Create (or reuse) a VS Code terminal
        const terminal = vscode.window.createTerminal({ name: `${Remote_server.AIX_HOST}_Terminal` });

        terminal.show();

        // Send reverse SSH tunnel command
        const forwardCmd = `ssh -R ${Remote_server.port}:localhost:${Remote_server.port}  \
  -o StrictHostKeyChecking=no \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=3 ${userHost}`;
        terminal.sendText(forwardCmd, true);

        // Storing the terminal sessions listener so that if close the terminal remove those listeners
        Listeners.set(terminal, Pyproc);

}


function RsyncPath(Remote_server)
{
    return new Promise((resolve, reject) => {
        const whichRsync = spawn("ssh", [`${Remote_server.AIX_USER}@${Remote_server.AIX_HOST}`, "find / -name rsync 2>/dev/null | head -20"]);
        
        let rsyncPath = "";
        let stderr = "";
        whichRsync.stdout.on('data', (data) => {
            rsyncPath = data.toString();
            // Now ru
        });

        whichRsync.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        whichRsync.on('close', (code) => {
            if(code !== 0) {
                vscode.window.showErrorMessage(`Error finding rsync`);
                reject(new Error(`Error: No such file or directory: ${stderr}`));
            }

            rsyncPath = rsyncPath.split('\n').find(p => p.trim().endsWith('rsync')) || '';
                if (rsyncPath) {
                    Remote_server.rsync_path = rsyncPath.trim();
                    console.log(`Rsync path set to: ${Remote_server.rsync_path}`);
                    resolve(Remote_server.rsync_path);
                } else {
                    console.warn("Rsync not found on remote, using default");
                    resolve("");
                }

        });



    });

}


async function Boot(userHost,Remote_server) {
    try {
        // Start your watcher
        const { port, process: pyProc } = await startWatcher(watcherScript,Remote_server);

        console.log("Now safe to continue. Using port:", port);

        // Replace placeholder with port
        let finalSafeCode = safeCode.replace('VS_PORT', port);

        // Build SSH heredoc
const sshCmd = `
ssh -o StrictHostKeyChecking=no ${userHost} 'bash -s' <<'EOF'
if grep '^[[:space:]]*code[[:space:]]*\(\)[[:space:]]*{' "$HOME/.bashrc"; then
    sed -i '/^[[:space:]]*code[[:space:]]*\(\)[[:space:]]*{/,/^[[:space:]]*}/d' "$HOME/.bashrc"
fi
cat <<'EOC' >> "$HOME/.bashrc"
${finalSafeCode}
EOC
EOF`;

        // Execute the heredoc injection
        await exec(sshCmd,{env: process.env}); // so that at the remote we pass all SSH_AUTH_SOCK env etc to get agent forwarding.



        //Setting the port in the server instance
        Remote_server.SetPort(port);

        //Setting up the rsync path
        await RsyncPath(Remote_server);
        

        //Creat the terminal for reverse tunnel
        TerminalLoader(userHost,Remote_server,process);
       
        console.log("Boot sequence finished.");
    } catch (err) {
        console.error("Failed to start Boot:", err);
        throw err;
    }
}




async function mountSSHFS(context, value,Remote_server) {
    const [userHost, remotePath = '/'] = value.split(':');

    // checking if the server exists or not.
try {
    // -o BatchMode=yes prevents asking password
    // -o ConnectTimeout=5 sets timeout in seconds
    await exec(`ssh -o BatchMode=yes -o ConnectTimeout=5 ${value} "exit"`);  //now here it will come out of that proc and will proceed further
    vscode.window.showInformationMessage("✅ Connection successful!");
} catch (err) {
    if (err.message.includes("Could not resolve hostname")) {
        vscode.window.showErrorMessage("❌ Invalid hostname!");
        return;
    }
    // if (err.message.includes("Permission denied")) {
    //     vscode.window.showWarningMessage("⚠️ Host exists, but authentication failed!");
    //     return;
    // }
    if (err.message.includes("Connection timed out")) {
        vscode.window.showErrorMessage("❌ Host unreachable (timeout)");
        return;
    }
    vscode.window.showErrorMessage("❌ Connection failed: " + err.message);
}




    let keyPath = `${process.env.HOME}/.ssh/id_rsa_${Remote_server.AIX_HOST}`;

    Remote_server.Setkeypath(keyPath);





    const code_bash = fs.readFileSync(path.join(__dirname, 'code.sh'), 'utf8');
    safeCode = code_bash
        .replace(/"/g, '\"')
        .replace(/'/g, "\'")
        .replace(/\$/g, '\$');

    // Always prompt for password if key exists but remote access fails
    let needKeyInstall = false;
    // Try a test SSH connection using the key
        vscode.window.showInformationMessage(`Connecting  ${fs.existsSync(keyPath)} to ${value}...`);


    if (fs.existsSync(keyPath)) {
        try {
            await exec(`ssh -i ${keyPath} -o BatchMode=yes -o StrictHostKeyChecking=no ${userHost} "echo connected"`);
            console.log('SSH key works, no need to reinstall'); 
        } catch (err) {
        vscode.window.showErrorMessage(`Initial SSH connection failed:`);

            // If permission denied, we need to reinstall the key
            if (/Permission denied/.test(err.stderr || err.message)) {
                console.log('SSH key did not work, will reinstall');
                await exec(`yes y | ssh-keygen -t rsa -b 4096 -f ${keyPath} -N ""`);
                needKeyInstall = true;
            }
        }
    } else {
        vscode.window.showInformationMessage(`Connecting  ${keyPath} to ${value}...`);
        await exec(`yes y | ssh-keygen -t rsa -b 4096 -f ${keyPath} -N ""`);
        needKeyInstall = true;
    }

    let password = '';

    if(needKeyInstall ) {
        vscode.window.showErrorMessage(`Initial SSH connection failed:`);

    password = await vscode.window.showInputBox({
        prompt: `Enter password for ${userHost}`,
        password: true,
        ignoreFocusOut: true
    });
    if (!password) return;
}

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Mounting ${value}...` },
        async () => {
            try {
                if (needKeyInstall) {
                    // Optionally, regenerate the key if you want to always refresh
                    // await exec(`ssh-keygen -t rsa -b 4096 -f ${keyPath} -N ""`);

                    await runExpect(userHost, keyPath, password);
                    vscode.window.showInformationMessage(`SSH key copied to ${userHost}`);
                } else {
                    vscode.window.showInformationMessage(`SSH key already exists at ${keyPath} and works`);
                }

                watcherScript = path.join(__dirname, 'socket_watcher.py');  //initialising the connection to listen to the port from remote-aix.
                if (!fs.existsSync(watcherScript)) {
                    vscode.window.showErrorMessage('Watcher script not found');
                    return;
                }


                   // If config exists, check contents creating the connection so that we don't need to do handshake again and again.

                const sshConfigEntry = `
Host ${Remote_server.AIX_HOST}
    HostName ${Remote_server.AIX_HOST}
    User ${Remote_server.AIX_USER}
    IdentityFile ${keyPath}
    StrictHostKeyChecking no
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m
`;



                   const sshConfigPath = path.join(process.env.HOME ,"/.ssh/config");
                if (fs.existsSync(sshConfigPath)) {
                    const existingConfig = fs.readFileSync(sshConfigPath, "utf8");
                    const safeHost = Remote_server.AIX_HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    const safeKeyPath = keyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

                    const blockRegex = new RegExp(
                    String.raw`Host\s+${safeHost}\s*` +
                    String.raw`\n\s*HostName\s+${safeHost}\s*` +
                    String.raw`\n\s*User\s+${Remote_server.AIX_USER}\s*` +
                    String.raw`\n\s*IdentityFile\s+${safeKeyPath}\s*`,
                    "m"
                    );
                    if (blockRegex.test(existingConfig)) {
                        console.log(`SSH config for ${Remote_server.AIX_HOST} already exists, skipping append.`);
                       
                    }
                    else{
                        fs.appendFileSync(sshConfigPath, sshConfigEntry, { encoding: "utf8" });
                        console.log(`SSH config for ${Remote_server.AIX_HOST} added.`);
                    }
                }

                // Append if not found
               
                await Boot(userHost,Remote_server);
  
                //setting up the base setup 
                saveConfig(context, value);
             
                // creating temp dir for this server
                Remote_server.CreatingTempDir();

                vscode.window.showInformationMessage(`Mounted: ${value}`);
            } catch (err) {
                vscode.window.showErrorMessage(`Mount failed: ${err.message}`);
                return;
            }
        }
    );
}

function runExpect(userHost, keyPath, password) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, 'expect.sh');
        const child = spawn('expect', [scriptPath, userHost, keyPath, password]);

        child.stdout.on('data', data => console.log(`expect: ${data}`));
        child.stderr.on('data', data => console.error(`expect error: ${data}`));

        child.on('close', (code) => {
            if (code === 0) resolve();
            else if (code === 1) {
                console.warn('Expect exited with code 1 — likely key already exists, continuing...');
                resolve();
            } else reject(new Error(`Expect failed with code ${code}`));
        });
    });
}

function deactivate() {
    for (const [host, server] of Servers) {
    try {
        fs.rmSync(server.TEMP_DIR, { recursive: true, force: true });
        console.log(`Temp folder ${server.TEMP_DIR} deleted`);
    } catch (err) {
        console.error(`Failed to delete temp folder: ${err.message}`);
    }
}

for (const [terminal, pyproc] of Listeners) {
    console.log(" closingLS")
    if (pyproc) {
        pyproc.kill();
    }
}

Parenttodir.clear();
uriLocaltoRemote.clear();
Servers.clear();
Listeners.clear();

}

module.exports = { activate, deactivate };
