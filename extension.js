const util = require('util');
const exec = util.promisify(require('child_process').exec);
const spawn = require('child_process').spawn;
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const chokidar = require('chokidar');



// Global map to store all server instances
const Servers = new Map();


// common to all servers
let LOCAL_SYNC_DIR = '';
let mount_dir = '';
let watcherScript = '';
let safeCode ='';

class Server
{
    constructor(LOCAL_COMMAND_FILE,AIX_HOST,AIX_USER,TEMP_DIR)
    {
        this.LOCAL_COMMAND_FILE = LOCAL_COMMAND_FILE;
        this.AIX_HOST = AIX_HOST;
        this.AIX_USER = AIX_USER;
        this.TEMP_DIR = TEMP_DIR;
        this.localtoRemote = new Map();
    }

    updateLocalToRemote(remotePath,fileName)
    {
        this.localtoRemote.set(fileName,remotePath);
        fs.writeFileSync(path.join(this.TEMP_DIR,`${this.AIX_HOST}_files.json`),JSON.stringify(this.localtoRemote));

    }


    CreatingTempDir()
    {
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
    }

    Setkeypath(keyPath)
    {
        this.keyPath = keyPath;
    }
}

const Client = require('ssh2-sftp-client')

class AixFSProvider {
    constructor(aixUser, aixHost, keyPath, temp_dir) {
        this.aixUser = aixUser;
        this.aixHost = aixHost;
        this.keyPath = keyPath;
        this.tempDir = temp_dir || path.join(require('os').tmpdir(), 'aixfs');
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeFile = this._emitter.event;

        this._lastModified = new Map();
        this.sftp = new Client();

        // lazy connect
        this._connectPromise = this.sftp.connect({
            host: this.aixHost,
            username: this.aixUser,
            privateKey: fs.readFileSync(this.keyPath)
        }).catch(err => {
            vscode.window.showErrorMessage(`SFTP connect failed: ${err.message}`);
        });
    }

    async readFile(uri) {
        await this._connectPromise;
        const remotePath = uri.path;
        const preview_localPath = path.join(require('os').tmpdir(), path.basename(remotePath) + 'view');
        const localPath = path.join(this.tempDir, path.basename(remotePath));

        vscode.window.setStatusBarMessage(`Reading file from AIX: ${remotePath}`, 2000);

        try {
            await this.sftp.fastGet(remotePath, preview_localPath);
            fs.copyFileSync(preview_localPath, localPath);

            // Save mtime
            const stat = await this.sftp.stat(remotePath);
            this._lastModified.set(remotePath, stat.modifyTime);

            return fs.readFileSync(preview_localPath); // Buffer for VS Code API
        }  catch (err) {
        // If file not found on remote, create empty file locally
        if (err.code === 2 || /No such file/i.test(err.message)) {
            fs.writeFileSync(preview_localPath, ""); // create empty file
            return Buffer.from(""); // return empty buffer to VS Code
        }

        throw new Error(`readFile failed for ${remotePath}: ${err.message}`);
    }
    }

    async writeFile(uri, content, options) {
        await this._connectPromise;
        const remotePath = uri.path;
        const tmpFile = path.join(this.tempDir, path.basename(remotePath));
        const preview_tmpFile = path.join(require('os').tmpdir(), path.basename(remotePath) + 'view');

        fs.writeFileSync(preview_tmpFile, content);

        try {
            await this.sftp.fastPut(preview_tmpFile, remotePath);
            fs.copyFileSync(preview_tmpFile, tmpFile);

            const stat = await this.sftp.stat(remotePath);
            this._lastModified.set(remotePath, stat.modifyTime);

            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        } catch (err) {
            throw new Error(`writeFile failed for ${remotePath}: ${err.message}`);
        }
    }

    watch(uri, options) {
        const remotePath = uri.path;

        const interval = setInterval(async () => {
            try {
                await this._connectPromise;
                const stat = await this.sftp.stat(remotePath);
                const mtime = stat.modifyTime;
                const lastMtime = this._lastModified.get(remotePath);

                if (!lastMtime) {
                    this._lastModified.set(remotePath, mtime);
                } else if (mtime !== lastMtime) {
                    this._lastModified.set(remotePath, mtime);

                    // Trigger change event, consumer will re-read
                    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
                }
            } catch (err) {
                console.error(`Watch error for ${remotePath}: ${err.message}`);
            }
        }, 2000); // faster than before (2s instead of 3s)

        return new vscode.Disposable(() => clearInterval(interval));
    }

    stat(uri) {
        return { type: vscode.FileType.File, ctime: Date.now(), mtime: Date.now(), size: 0 };
    }
    readDirectory() { return []; }
    createDirectory() {}
    delete() {}
    rename() {}
}



function activate(context) {
    const disposable = vscode.commands.registerCommand('remote-rsync.helloWorld', async function () {

       //defining variables here
        let LOCAL_COMMAND_FILE = '';
        let AIX_USER = '';
        let AIX_HOST = '';
        let localtoRemote = new Map();
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
        await mountSSHFS(context, value, mount_dir,logins,Remote_server);
      
        Servers.set(AIX_HOST, Remote_server);

        // Register the virtual file system provider for aix:
        const provider = new AixFSProvider(AIX_USER, AIX_HOST, Remote_server.keyPath,TEMP_DIR);
        context.subscriptions.push(
            vscode.workspace.registerFileSystemProvider(`aix_${AIX_HOST}`, provider, { isCaseSensitive: true })
        );

        // for the case when we load the files from local temp
     vscode.workspace.onDidOpenTextDocument(doc => {
    const filePath = doc.uri.fsPath;
    if (filePath.startsWith(TEMP_DIR)) {
        const fileName = path.basename(filePath);
        const remotePath = localtoRemote.get(fileName);
        const vfsUri = vscode.Uri.parse(`aix_${AIX_HOST}:${remotePath}`);

        // Close the local one
        vscode.commands.executeCommand('workbench.action.closeActiveEditor').then(() => {
            // Open the VFS one instead
            vscode.commands.executeCommand('vscode.open', vfsUri);
        });
    }

    
});


        watchCommandFile(Remote_server);
    });

    context.subscriptions.push(disposable);
}

function watchCommandFile(Remote_server) {

    chokidar.watch(Remote_server.LOCAL_COMMAND_FILE).on('change', () => {
        const target = fs.readFileSync(Remote_server.LOCAL_COMMAND_FILE, 'utf8').trim();
        if (target) pullFromAix(target,Remote_server);
    });
}

async function pullFromAix(remotePath,Remote_server) {
    remotePath = path.posix.normalize(remotePath);
    Remote_server.updateLocalToRemote(remotePath,path.basename(remotePath));
    fs.writeFileSync(path.join(Remote_server.TEMP_DIR,`${Remote_server.AIX_HOST}_files.json`),JSON.stringify(Remote_server.localtoRemote));

    const uri = vscode.Uri.parse(`aix_${Remote_server.AIX_HOST}:${remotePath}`);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
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


async function Boot(userHost,Remote_server) {
    try {
        // Start your watcher
        const { port, process: pyProc } = await startWatcher(watcherScript,Remote_server);

        console.log("Now safe to continue. Using port:", port);

        // Replace placeholder with port
        let finalSafeCode = safeCode.replace('VS_PORT', port);

        // Build SSH heredoc
        const sshCmd = `
ssh -i ${Remote_server.keyPath} -o StrictHostKeyChecking=no ${userHost} 'bash -s' <<'EOF'
# Overwrite old code() function first
if grep -q '^[[:space:]]*code() {' ~/.bashrc; then
    sed -i "/^[[:space:]]*code() {/,/^[[:space:]]*}/d" ~/.bashrc
fi

# Append the new function safely
cat <<'EOC' >> ~/.bashrc
${finalSafeCode}
EOC
EOF`;

        // Execute the heredoc injection
        await exec(sshCmd,{env: process.env}); // so that at the remote we pass all SSH_AUTH_SOCK env etc to get agent forwarding.

        // Create (or reuse) a VS Code terminal
        const terminal = vscode.window.createTerminal({ name: "RSync Terminal" });

        terminal.show();

        // Send reverse SSH tunnel command
        const forwardCmd = `ssh -R ${port}:localhost:${port} -i ${Remote_server.keyPath} -o StrictHostKeyChecking=no ${userHost}`;
        terminal.sendText(forwardCmd, true);

        console.log("Boot sequence finished.");
    } catch (err) {
        console.error("Failed to start Boot:", err);
        throw err;
    }
}




async function mountSSHFS(context, value, mount_dir,logins,Remote_server) {
    const [userHost, remotePath = '/'] = value.split(':');

    // checking if the server exists or not.

    try{
     await exec(`ssh ${value}`)
    }
    catch(err){
 
        if(err.message.includes("Could not resolve hostname")){

        return;
    }


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
        password: true
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

                watcherScript = path.join(__dirname, 'socket_watcher.py');
                if (!fs.existsSync(watcherScript)) {
                    vscode.window.showErrorMessage('Watcher script not found');
                    return;
                }
      
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
}



module.exports = { activate, deactivate };
