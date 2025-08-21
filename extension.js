

const util = require('util');
const exec = util.promisify(require('child_process').exec);
const spawn = require('child_process').spawn;
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const chokidar = require('chokidar');

let LOCAL_COMMAND_FILE = '';
let LOCAL_SYNC_DIR = '';
let AIX_USER = '';
let AIX_HOST = '';
let mount_dir = '';
let keyPath = '';
let localtoRemote = new Map();
let TEMP_DIR = '';
let ssh_terminal = '';
let watcherScript = '';
let safeCode ='';

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
            fs.writeFileSync(localPath, "");
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
        mount_dir = vscode.workspace.workspaceFolders[0].uri.fsPath;
        fs.mkdirSync(path.join(mount_dir, '.sshfs'), { recursive: true });
        LOCAL_SYNC_DIR = path.join(mount_dir, '.sshfs');

        const logins = loadconfig(context) || [];
        const quickPickItems = [
            ...logins.map(login => ({ label: login })),
            { label: 'Enter new login', alwaysShow: true }
        ];
        const selected = await vscode.window.showQuickPick(quickPickItems, { placeHolder: 'Select a saved login or enter a new one' });
        if (!selected) return;

        let value = selected.label;
        if (value === 'Enter new login') {
            const input = await vscode.window.showInputBox({ prompt: 'Enter username@ip_address:/' });
            if (!input) return;
            value = input;
        }

        [AIX_USER, AIX_HOST] = value.split('@');
        await mountSSHFS(context, value, mount_dir);

       TEMP_DIR = path.join(mount_dir, `temp_${AIX_HOST}`);
       fs.mkdirSync(TEMP_DIR, { recursive: true });

        // Register the virtual file system provider for aix:
        const provider = new AixFSProvider(AIX_USER, AIX_HOST, keyPath,TEMP_DIR);
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


        watchCommandFile();
    });

    context.subscriptions.push(disposable);
}

function watchCommandFile() {
    LOCAL_COMMAND_FILE = path.join(LOCAL_SYNC_DIR, `command_${AIX_HOST}.txt`);

    chokidar.watch(LOCAL_COMMAND_FILE).on('change', () => {
        const target = fs.readFileSync(LOCAL_COMMAND_FILE, 'utf8').trim();
        if (target) pullFromAix(target);
    });
}

async function pullFromAix(remotePath) {
    remotePath = path.posix.normalize(remotePath);
    localtoRemote.set(path.basename(remotePath),remotePath);
    fs.writeFileSync(path.join(TEMP_DIR,`${AIX_HOST}_files.json`),JSON.stringify(localtoRemote));

    const uri = vscode.Uri.parse(`aix_${AIX_HOST}:${remotePath}`);
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

function startWatcher(watcherScript) {
    return new Promise((resolve, reject) => {
        fs.chmodSync(watcherScript, "755");

        const pyProc = spawn("python3", [watcherScript,path.join(LOCAL_SYNC_DIR,`command_${AIX_HOST}.txt`)], {
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


async function Boot(userHost) {
    try {
        // Start your watcher
        const { port, process: pyProc } = await startWatcher(watcherScript);

        console.log("Now safe to continue. Using port:", port);

        // Replace placeholder with port
        let finalSafeCode = safeCode.replace('VS_PORT', port);

        // Build SSH heredoc
        const sshCmd = `
ssh -i ${keyPath} -o StrictHostKeyChecking=no ${userHost} 'bash -s' <<'EOF'
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
        await exec(sshCmd);

        // Create (or reuse) a VS Code terminal
        if (!globalThis.rsyncTerminal || globalThis.rsyncTerminal.exitStatus) {
            globalThis.rsyncTerminal = vscode.window.createTerminal({ name: "RSync Terminal" });
        }
        const terminal = globalThis.rsyncTerminal;

        terminal.show();

        // Send reverse SSH tunnel command
        const forwardCmd = `ssh -R ${port}:localhost:${port} -i ${keyPath} -o StrictHostKeyChecking=no ${userHost}`;
        terminal.sendText(forwardCmd, true);

        console.log("Boot sequence finished.");
    } catch (err) {
        console.error("Failed to start Boot:", err);
    }
}




async function mountSSHFS(context, value, mount_dir) {
    const [userHost, remotePath = '/'] = value.split(':');
    keyPath = `${process.env.HOME}/.ssh/id_rsa_${AIX_HOST}`;
    const code_bash = fs.readFileSync(path.join(__dirname, 'code.sh'), 'utf8');
    safeCode = code_bash
        .replace(/"/g, '\"')
        .replace(/'/g, "\'")
        .replace(/\$/g, '\$');

    if (!fs.existsSync(keyPath)) {
        await exec(`ssh-keygen -t rsa -b 4096 -f ${keyPath} -N ""`);
    }

    const password = await vscode.window.showInputBox({
        prompt: `Enter password for ${userHost}`,
        password: true
    });
    if (!password) return;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Mounting ${value}...` },
        async () => {
            try {
                if(!fs.existsSync(keyPath)) {
                await runExpect(userHost, keyPath, password);
                vscode.window.showInformationMessage(`SSH key copied to ${userHost}`);
                } else {
                vscode.window.showInformationMessage(`SSH key already exists at ${keyPath}`);
                }
            

                 watcherScript = path.join(__dirname, 'socket_watcher.py');
                if (!fs.existsSync(watcherScript)) {
                    vscode.window.showErrorMessage('Watcher script not found');
                    return;
                }

                 // port no it is listening to 

                 await Boot(userHost);
              

                
               

                saveConfig(context, value);
                vscode.window.showInformationMessage(`Mounted: ${value}`);
            } catch (err) {
                vscode.window.showErrorMessage(`Mount failed: ${err.message}`);
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
    try {
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        console.log(`Temp folder ${TEMP_DIR} deleted`);
    } catch (err) {
        console.error(`Failed to delete temp folder: ${err.message}`);
    }
}



module.exports = { activate, deactivate };
