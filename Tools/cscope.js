

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const util = require('util');
const exec = util.promisify(require('child_process').exec);





async function queryCscope(scopeFile, queryType, symbol,Remote_server) {
  const cmd = `ssh ${Remote_server.AIX_USER}@${Remote_server.AIX_HOST} "cscope -d -f ${scopeFile} -L${queryType} ${symbol}"`;
  const output = spawnSync(cmd, {encoding: 'utf-8' , shell: true});
  if (output.error) throw  (output.error);

  const fileset = output.stdout;


  
  // console.log(`Cscope command executed: ${fileset}`);
  let fileEntries = [];
  let jsonFileEntries=[];

  fileEntries = fileset.split("\n");

  // console.log(`Cscope command returned entries: ${fileEntries[0]}`);

  let parts = [];
  for(let line of fileEntries) {
    parts = line.trim().split(/\s+/);

    // console.log(`line: ${line}, parts[0]: ${parts[0]} , parts[1]: ${parts[1]} , parts[2]: ${parts[2]} , parts[3]: ${parts[3]} `);
    if(parts.length < 3) {
      console.warn(`Skipping malformed line: ${line}`);
      continue;
    }
    jsonFileEntries.push({
       file: parts[0],
      function: parts[1],
      line: parseInt(parts[2]),
      text: parts.slice(3).join(" ")
      });
    
  }
  // console.log(`Cscope query returned ${jsonFileEntries.length} entries`);
     
  // console.log(`Cscope query returned ${jsonFileEntries} entries`);
  return jsonFileEntries;
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

// Main function
function Cscope(Remote_server,dirname)
{
    // calling the cscope command on aix
    const scopeFile = path.posix.join(dirname, 'cscope.out');

    const sshcmd = `ssh -o StrictHostKeyChecking=no ${Remote_server.AIX_USER}@${Remote_server.AIX_HOST} "test -f ${scopeFile} && echo 'exists' || echo 'not exists'"`;

    const cscope_exists = spawnSync(sshcmd, {
      encoding: "utf-8",
      shell: true
    });


    console.log(`ssh command check if cscope exists: ${cscope_exists.stdout}`);

    if (cscope_exists && cscope_exists.stdout.trim() === 'exists') {
        console.log('Cscope database already exists on AIX');
    }
    else{
         const sshcmd1 = `ssh -o StrictHostKeyChecking=no ${Remote_server.AIX_USER}@${Remote_server.AIX_HOST} "cd ${dirname} && find . -name "*.c" -o -name "*.cpp" -o -name "*.h" > cscope.files &&
cscope -b -q -k -i cscope.files"`;
      const cscope_create = spawnSync(sshcmd1, { encoding: 'utf-8', shell: true });

      if(cscope_create.error)
      {
        console.error('Failed to create cscope database:', cscope_create.error);
        return null;
      }
    }

}


module.exports = { Cscope,queryCscope };