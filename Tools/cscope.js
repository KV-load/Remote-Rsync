const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const util = require('util');
const exec = util.promisify(require('child_process').exec);





function queryCscope(scopeFile, queryType, symbol) {
  const cmd = `cscope -d -f ${scopeFile} -L -${queryType} ${symbol}`;
  const output = execSync(cmd).toString();
  return output.split("\n").filter(Boolean).map(line => {
    const parts = line.trim().split(/\s+/);
    return {
      file: parts[0],
      function: parts[1],
      line: parseInt(parts[2]),
      text: parts.slice(3).join(" ")
    };
  });
}

function buildJson(server, queries) {
  const result = { [server]: {} };

  queries.forEach(entry => {
    const { file, function: func, line, text } = entry;
    const folder = file.split("/").slice(0, -1).join("/");
    const filename = file.split("/").pop();

    if (!result[server][folder]) result[server][folder] = {};
    if (!result[server][folder][filename]) result[server][folder][filename] = {};
    
    result[server][folder][filename][func] = {
      return_type: extractReturnType(text),
      parameters: extractParameters(text),
      line_number: line
    };
  });

  return result;
}

function extractReturnType(text) {
  // simple regex example: "int func(int a, char *b)"
  const match = text.match(/^(\w+)\s+\w+\(/);
  return match ? match[1] : "unknown";
}

function extractParameters(text) {
  const match = text.match(/\(([^)]*)\)/);
  return match ? match[1].split(",").map(p => p.trim()) : [];
}


function sleep(ms) {  
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function execCommand(command,attempts=5,delay=2000){
  let result = false;
  for(let i=0;i<attempts;i++)
  {
    try{
      await exec(command);
      console.log('command execution successful');
      result = true;
      break;
    }
    catch(e)
    {
      await sleep(delay);
    }
  }
  if(!result)
  {
    throw new Error('command execution failed after multiple attempts');
  }
}

async function Exec(file_tranfer)
{
  try{
    for (let i = 0; i < file_tranfer.length; i++) {
        try {
            await execCommand(file_tranfer[i]);
            console.log(`File transfer ${i} completed successfully`);
        } catch (err) {
            console.error(`File transfer ${i} failed:`, err);
            return null;
        }
    }
  }
  catch(e)
  {
    throw e;
  }
}

// Main function
function Cscope(Remote_server,dirname,mount_dir)
{
    // calling the cscope command on aix
    const scopeFile = path.posix.join(dirname, 'cscope.out');
    const sshcmd1 = `ssh -i ${Remote_server.keyPath} -o StrictHostKeyChecking=no ${Remote_server.AIX_USER}@${Remote_server.AIX_HOST} "cd ${dirname} && find . -name "*.c" -o -name "*.cpp" -o -name "*.h" > cscope.files
cscope -b -q -k -i cscope.files"`;
    const sshcmd2 = `ssh -i ${Remote_server.keyPath} -o StrictHostKeyChecking=no ${Remote_server.AIX_USER}@${Remote_server.AIX_HOST} "cd ${dirname} && ~/ctags-universal/bin/ctags -R --c-kinds=+p --fields=+n+S+R --languages=C,C++ -f vs_tags ."`;
    try {
        exec(sshcmd1);
        exec(sshcmd2);
        console.log('Cscope database built successfully on AIX');
    } catch (err) {
        console.error('Failed to build cscope database:', err);
        return null;
    }

    // getting the files back to local temp dir
    const localScopeDir = path.join(mount_dir, path.basename(dirname));
    fs.mkdirSync(localScopeDir, { recursive: true });

    //filepath on aix
    const scopeFileAix = path.posix.join(dirname, 'cscope.out');
    const scope_index = path.posix.join(dirname, 'cscope.in.out');
    const scope_index_func = path.posix.join(dirname, 'cscope.po.out');
    const tags_file = path.posix.join(dirname, 'vs_tags');
    console.log('Transferring files to local directory:', tags_file);

    let file_tranfer = [];
  
    file_tranfer[0] = `rsync -az -i ${Remote_server.keyPath} -e "ssh -o StrictHostKeyChecking=no" ${Remote_server.AIX_USER}@${Remote_server.AIX_HOST}:${scopeFileAix} ${localScopeDir}`;
    file_tranfer[1] = `rsync -az -i ${Remote_server.keyPath} -e "ssh -o StrictHostKeyChecking=no" ${Remote_server.AIX_USER}@${Remote_server.AIX_HOST}:${scope_index} ${localScopeDir}`;
    file_tranfer[2] = `rsync -az -i ${Remote_server.keyPath} -e "ssh -o StrictHostKeyChecking=no" ${Remote_server.AIX_USER}@${Remote_server.AIX_HOST}:${scope_index_func} ${localScopeDir}`;
    file_tranfer[3]= `rsync -az -i ${Remote_server.keyPath} -e "ssh -o StrictHostKeyChecking=no" ${Remote_server.AIX_USER}@${Remote_server.AIX_HOST}:${tags_file} ${localScopeDir}`;

    try{
        Exec(file_tranfer);
    }
    catch(e)
    {
        console.error('File transfer failed:', e);
        return null;
    }

}

module.exports = { Cscope };