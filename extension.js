

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

class AixFSProvider {
    constructor(aixUser, aixHost, keyPath,temp_dir) {
        this.aixUser = aixUser;
        this.aixHost = aixHost;
        this.keyPath = keyPath;
        this.tempDir = temp_dir || path.join(require('os').tmpdir(), 'aixfs');
        this._emitter = new vscode.EventEmitter(); // Needed for watch
        this.onDidChangeFile = this._emitter.event;

        // Store last known mtimes to detect changes
        this._lastModified = new Map();
    }

async readFile(uri) {
    const remotePath = uri.path;
    const preview_localPath = path.join(require('os').tmpdir(), path.basename(remotePath)+'view');
    const localPath = path.join(this.tempDir, path.basename(remotePath));

    vscode.window.setStatusBarMessage(`Reading file from AIX: ${remotePath}`, 2000);
   
    return new Promise((resolve, reject) => {
        const chunks = [];
        const sshProc = spawn('rsync', [
            '-avz',
            '-e', `ssh -i ${this.keyPath}`,
            `${this.aixUser}@${this.aixHost}:"${remotePath}"`,
            preview_localPath
        ]);

        sshProc.stdout.on('data', chunk => chunks.push(chunk));
        sshProc.stderr.on('data', err => console.error(`SSH error: ${err}`));

        sshProc.on('close', code => {
            if (code === 0) {
                // Save mtime
                this._lastModified.set(remotePath, Date.now());
                exec(`cp "${preview_localPath}" "${localPath}"`)
                resolve(fs.readFileSync(preview_localPath)); // still return Buffer for VS Code API
            } else {
                reject(new Error(`SSH exited with code ${code}`));
            }
        });
    });
}


    async writeFile(uri, content, options) {
        const remotePath = uri.path;
        const tmpFile = path.join(this.tempDir, path.basename(remotePath));
        const preview_tmpFile =  path.join(require('os').tmpdir(), path.basename(remotePath)+'view');
        fs.writeFileSync(preview_tmpFile, content);
        await exec(
            `rsync -avz -e "ssh -i ${this.keyPath}" "${preview_tmpFile}" ${this.aixUser}@${this.aixHost}:"${remotePath}"`
        );
        await exec('cp ' + preview_tmpFile + ' ' + tmpFile);

        // Update mtime after writing
        this._lastModified.set(remotePath, Date.now());

        // Notify watchers
        this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

watch(uri, options) {
    const remotePath = uri.path;
    const localPath = path.join(this.tempDir, path.basename(remotePath));

    const interval = setInterval(async () => {
        try {
            const { stdout } = await exec(
                `ssh -i ${this.keyPath} ${this.aixUser}@${this.aixHost} "perl -e 'print ((stat shift)[9])' '${remotePath}'"`
            );

            const mtime = parseInt(stdout.trim(), 10);
            const lastMtime = this._lastModified.get(remotePath);

            if (!lastMtime) {
                this._lastModified.set(remotePath, mtime);
            } else if (mtime !== lastMtime) {
                this._lastModified.set(remotePath, mtime);

                // Pull new version to temp folder
                //Pull new version to the preview mode

                // await exec(`rsync -avz -e "ssh -i ${this.keyPath}" "${this.aixUser}@${this.aixHost}:'${remotePath}'" "${localPath}"`);

                this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
            }
        } catch (err) {
            console.error(`Watch error for ${remotePath}: ${err.message}`);
        }
    }, 3000);

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

        // Check if it's inside your temp dir
        if (filePath.startsWith(TEMP_DIR)) {
            const fileName = path.basename(filePath);
            
            // Figure out the remote path mapping from filename
            const remotePath = localtoRemote.get(fileName);

            // Re-open using your VFS scheme
            const vfsUri = vscode.Uri.parse(`aix_${AIX_HOST}:${remotePath}`);
            vscode.workspace.openTextDocument(vfsUri).then(newDoc => {
                vscode.window.showTextDocument(newDoc, { preview: true });
                 vscode.commands.executeCommand('workbench.action.closeActiveEditor');  // to close the opened local fileeditor.
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
    const uri = vscode.Uri.parse(`aix_${AIX_HOST}:${remotePath}`);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
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

async function mountSSHFS(context, value, mount_dir) {
    const [userHost, remotePath = '/'] = value.split(':');
    keyPath = `${process.env.HOME}/.ssh/id_rsa_${AIX_HOST}`;
    const code_bash = fs.readFileSync(path.join(__dirname, 'code.sh'), 'utf8');
    const safeCode = code_bash
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
            

                const mkdirCmd = `ssh -i ${keyPath} -o StrictHostKeyChecking=no ${userHost} 'bash -s' <<'EOF'
                mkdir -p ~/.sshfs
                > ~/.sshfs/command.txt
                echo /pkgs.txt >> ~/.sshfs/command.txt
                > ~/.bashrc
                cat <<'EOC' >> ~/.bashrc
                ${safeCode}`;
                await exec(mkdirCmd);

                const watcherScript = path.join(__dirname, 'watcher.py');
                if (!fs.existsSync(watcherScript)) {
                    vscode.window.showErrorMessage('Watcher script not found');
                    return;
                }
                fs.chmodSync(watcherScript, '755');
                const pyProc = spawn('python3', [watcherScript, AIX_USER, AIX_HOST, keyPath, LOCAL_SYNC_DIR]);
                pyProc.stdout.on('data', data => console.log(`Watcher: ${data}`));
                pyProc.stderr.on('data', err => console.error(`Watcher error: ${err}`));

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
