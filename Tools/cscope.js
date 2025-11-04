
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const util = require('util');
const exec = util.promisify(require('child_process').exec);

const hash_path  = require('../Tools/Fileprovider').hash_path;

const vscode = require('vscode');

async function queryCscope(scopeFile, queryType, symbol,Remote_server) {
   let query=1;
    if(queryType === "define")
    {
      query =1;
    }
    else if(queryType === "refrences")
    {
      query = 2;
    }
  const cmd = `ssh ${Remote_server.AIX_USER}@${Remote_server.AIX_HOST} "cscope -d -f ${scopeFile} -L${query} ${symbol}"`;
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



async function vscodeQuery(provider,uriLocaltoRemote,document,position,Servers,queryType)
{
   vscode.window.showInformationMessage(`Server restart successful`);

         
         
  
          //Getting the server name from the uri
  
          //getting metadata from the uri
          const remote_uri = uriLocaltoRemote.get(document.uri.toString());

          const frag = new URLSearchParams(remote_uri.fragment);

          const server_name = remote_uri.authority;

          
          const cur_server = Servers.get(server_name);
  
  
          const dir_name = frag.get('cscope_dir');  // getting the root directory of the project where cscope is stored or created.
          const scopeFile = path.join(dir_name,'cscope.out'); // getting the cscope.out.
  
          // Getting my old cscope logic
          let remoteResult=[];
          const symbol = document.getText(document.getWordRangeAtPosition(position));
          remoteResult = await queryCscope(scopeFile,queryType,symbol,cur_server);
  
          if(!remoteResult){return[];}
  
          // console.log(`Found ${remoteResult[remoteResult.length-1]} results for query on Aix`);
          let remote_filepath="";
          let result= [];
           let uri =null;
          let localFile="";
          let fakeuri_frag="";
          let local_uri=null;
          let aix_uri = null;

          // storing the dir_name of the folder wrt each file stored as a fragment and the remote_filePath.

              const aix_frag = new URLSearchParams({
                  cscope_dir: dir_name,
                  }).toString();

          for(const entry of remoteResult)
          {
              remote_filepath = path.join(dir_name,entry.file);
              vscode.window.showInformationMessage(remote_filepath);
  
              // await pullFromAix(remote_filepath,cur_server,"Nopen"); //Don't want to open the file direclty when user clicks on it then it will be opened.
              // uri = [...uriLocaltoRemote].find(([local, remote]) => remote.path === remote_filepath)?.[0];
              // uri=vscode.Uri.parse(uri);
              // if(!uri)
              // {
              //     continue;
              // }
  
                  // const localFile = await hash_path(remote_filepath,cur_server);


                // await provider.readFile(aix_uri); // Ensure file is cached locally
                  
                  // setting up the fake uri so that i just see the repo only not the whole files fetched and then whichever file I click will be fetched.
                
                localFile = await hash_path(remote_filepath,cur_server);

             
  
                console.log("Opeinig ths file here",localFile);

              
                if(fs.existsSync(localFile)===false)
                {
                      aix_uri = vscode.Uri.from({
                              scheme: "aix",
                              authority: cur_server.AIX_HOST,
                              path: remote_filepath,
                              });
                  
                                  // Creating the fragment for the uri
                              const frag = new URLSearchParams({
                              cscope_dir: dir_name,
                              }).toString();
                  
                              aix_uri = aix_uri.with({fragment: frag});
                  
                              await provider.readFile(aix_uri);  
                }
             
                  local_uri = vscode.Uri.file(localFile);
                  // uri = vscode.Uri.from({
                  // scheme: "fake_aix",
                  // authority: cur_server.AIX_HOST,
                  // path: localFile, // so that it shows the localpath instead of the remote path
                  // });

                
                  // vscode.workspace.openTextDocument(local_uri); // Open the document to ensure it's loaded in VSCode

                fakeuri_frag = new URLSearchParams({
                              cscope_rootdir: dir_name ,
                              authority: cur_server.AIX_HOST,
                              path: remote_filepath,
                              }).toString();
                  
                
                uri = local_uri.with({fragment: fakeuri_frag});
                console.log(remote_filepath);

              
                // console.log(entry.line);
              
              const pos = new vscode.Position(entry.line - 1, 0);  
              result.push(new vscode.Location(uri, pos));
          }
          return result;
          
      
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


module.exports = { Cscope,queryCscope,vscodeQuery};