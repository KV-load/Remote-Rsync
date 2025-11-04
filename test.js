class server{
    constructor()
    {
        this.localfoldertoRemote=new Map();
    }
}

const commonmap = new server();

commonmap.localfoldertoRemote.set('/remote/path/example','local_folder_1');

console.log(commonmap.localfoldertoRemote.get('/remote/path/example')); // Outputs: local_folder_1