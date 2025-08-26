const WebSocket = require("ws");
const fs = require("fs");
const dgram = require("dgram");
const uuid = require("uuid");
const https = require("https");
const sha256 = require("sha256");
const dns = require('dns').promises;

const PLAIN_PORT = 3425;
const SSL_PORT = 3426;
const ASK_PORT = 100;

let conf = {
    admin: {
        username: "root",
        password: "password"
    },
    blocked_servers: [],
    settings: {
        defaultMailStorage: 1024 * 1024 * 1024 * 1,
        welcomeMessage: "Welcome back you Stellar!",
        serverName: "StellarMail",
        use_ssl: false,
        enforce_ssl_connection: false,
        domain_root: "dragonrelay.net", // If you want others to send you a reply back then this must be included otherwise just leave it blank I guess... (leave blank for no way to respond)
        cert: "", // Sets a public certificate that the server must use for use_ssl if enabled.
        key_cert: "" // Sets a private key that the server must use for use_ssl if enabled.
    }
};

if(fs.existsSync("config.json")) {
    conf = JSON.parse(fs.readFileSync("config.json"));
} else {
    fs.writeFileSync("config.json", JSON.stringify(conf, null, '\t'));
}

if(!fs.existsSync("data")) {
    fs.mkdir("data");
}

let users = {};
let server;

if(fs.existsSync("users.json")) {
    users = JSON.parse(fs.readFileSync("users.json"));
} else {
    fs.writeFileSync("users.json", JSON.stringify(users, null, '\t'));
}

if(!conf.settings.use_ssl == true) {
    server = new WebSocket.Server({port: PLAIN_PORT});
} else {
    const httpsServer = https.createServer({
        key: fs.readFileSync(conf.settings.key_cert),
        cert: fs.readFileSync(conf.settings.cert)
    });

    server = new WebSocket.Server({
        server: httpsServer
    });

    httpsServer.listen(SSL_PORT);
}

function send(socket, map) {
    var p = map;
    socket.send(JSON.stringify(p));
}

function saveJson() {
    fs.writeFileSync("config.json", JSON.stringify(conf, null, '\t'));
    fs.writeFileSync("users.json", JSON.stringify(users, null, '\t'));
}

function formatAddress(ip, type = 'ipv4') {
    switch(type) {
        case "ipv4":
            var s = ip.split(":");
            return s[s.length - 1];
        case "ipv6":
            var s = ip.split(":");
            var sf = "";
            for(var i=0; i<s.length - 1; i++) {
                if(sf == "") {
                    sf += s[i];
                } else {
                    sf += ":" + s[i];
                }
            }
            return sf;
        default:
            return false;
    }
}

async function checkDomainResolution(domain) {
    try {
        const addresses = await dns.resolve(domain, "A");
        if (addresses.length > 0) {
            return true;
        } else {
            return false;
        }
    } catch (err) {
        if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
            return false;
        } else {
            return false;
        }
    }
}

function purifyString(input) {
    return input.replace(/[^a-z0-9.]/g, '');
}

let clients = [];
let requestOutbox = [];
let currentlyProcessingRequest = false;

setInterval(function() {
    if(requestOutbox.length != 0 && currentlyProcessingRequest == false) {
        currentlyProcessingRequest = true;
        socketServer.send(JSON.stringify({
            id: "ASKINFO"
        }), ASK_PORT, requestOutbox[0]["server_to"]);

        // In-case the server is no longer able to process due to an error.
        requestOutbox[0]["reconnectError"] = setTimeout((s = requestOutbox) => {
            s.splice(0, 1);
            currentlyProcessingRequest = false;
            console.log("There was no response, assume the connection was timedout or forgotten.");
        }, 15000);
    }
});

server.on("connection", (socket, req) => {
    console.log("Client connected! Awaiting for their authorization...");
    socket.authed = false;
    socket.userid = null;
    socket.num = clients.length;
    var ipc = formatAddress(req.socket.remoteAddress);
    clients.push(socket);

    send(socket, {
        id: "WELCOME",
        message: conf.settings.welcomeMessage
    });

    socket.on("error", (err) => {
        console.log("Socket encountered an error: %d", err);
        socket.terminate();
    });

    socket.on("close", () => {
        console.log("Socket had disconnected from the email server. Unauthenticating...");
        socket.authed = false;
        socket.userid = null;
        clients[socket.num] = null;
    });

    socket.on("message", (msg) => {
        try {var p = JSON.parse(msg.toString("utf8"));}catch(e){var p = {id: "unknown"};}

        switch(p["id"]) {
            case "REG":
                console.log("Attempting to register "+p["user"]+"...");
                var user = purifyString(p["username"].toLowerCase()); // Ensure that lowercase strings are accepted for registration. This might change with the option to allow purifying the username or not.
                var pass = sha256(p["password"]); // DEVELOPER NOTE: JUST FOR TESTING! In production it will be using either encryption or hashing with salt.

                if(user in users && (user != "" || user != null)) {
                    console.log("Either already exists or empty username.");
                    send(socket, {
                        id: "REG_FAIL",
                        username: user
                    });
                } else {
                    console.log("Registering "+user+"...");
                    fs.mkdirSync("data/"+user);
                    fs.mkdirSync("data/"+user+"/inbox");
                    fs.mkdirSync("data/"+user+"/draft");
                    fs.mkdirSync("data/"+user+"/sent");
                    fs.mkdirSync("data/"+user+"/spam");
                    fs.mkdirSync("data/"+user+"/trash");
                    users[user] = {
                        password: pass,
                        banned: false,
                        profile_imageurl: "",
                        folders: {
                            inbox: {
                                alias: "Inbox",
                                files: []
                            },
                            draft: {
                                alias: "Draft",
                                files: []
                            },
                            sent: {
                                alias: "Sent",
                                files: []
                            },
                            spam: {
                                alias: "Spam",
                                files: []
                            },
                            trash: {
                                alias: "Trash",
                                files: []
                            }
                        },
                        blocked: [],
                        contacts: [],
                        auto_reply: "", // Can be blank for no auto response.,
                        info: {
                            first_name: "Bob",
                            last_name: "Smith",
                            age: 37,
                            website: "https://bobsmith.com/",
                            about_yourself: "Hello I am bob and I like cheeseburgers.",
                            youtube_channel: "",
                            x_profile: "",
                            facebook: "",
                            instagram: "",
                            tiktok: ""
                        },
                        rep_pts: [], // Stored like so {"user": "alex", "rep": 1} or {"user":"john", "rep": -1}
                        admin: false
                    }

                    send(socket, {
                        id: "REG_OK",
                        username: user
                    });
                }
                break;
            case "LOG":
                var user = purifyString(p["username"].toLowerCase());
                var pass = sha256(p["password"]); // DEVELOPER NOTE: JUST FOR TESTING! In production it will be using either encryption or hashing with salt.
                console.log("Attempting to login as "+user+"...");

                if(user in users) {
                    if(users[user]["password"] == pass) {
                        if(users[user].banned == true) {
                            send(socket, {
                                id: "BANNED"
                            });
                        } else {
                            console.log(user+" has been successfully logged in by "+ipc);
                            socket.authed = true;
                            socket.userid = user;

                            send(socket, {
                                id: "LOG_OK",
                                folders: users[user]["folders"],
                                username: user,
                                profile_image: users[user]["profile_imageurl"] || ""
                            });
                        }
                    } else {
                        console.log(user+" failed to authenticate by "+ipc);
                        send(socket, {
                            id: "LOG_FAIL"
                        });
                    }
                } else {
                    console.log(user+" doesn't exists on our database... So we're just gonna lie to them.");
                    send(socket, {
                        id: "LOG_FAIL"
                    });
                }
                break;
            case "OUTBOX":
                // When the server receives an outbox from another server have it process it.
                console.log("Whoa! Looks like we received a message from server "+ipc);
                // Process the server's request.
                console.log("Contemplating if user exists or not...");

                var construction = {
                    to: p["to"].toLowerCase(),
                    from: p["from"].toLowerCase(),
                    subject: p["subject"],
                    message: p["content"],
                    attachments: p["attachments"],
                    has_read: false,
                    sent_at: new Date().toLocaleString(),
                    drafted: false
                }
                var s = p["to"].split("@");
                var ss = p["from"].split("@");
                var u = users[s[0]];
                var uuid_file = uuid.v4();

                // Instead of checking ip addresses let's just block domain names (or ip addresses) and even if they manage to spoof it with a fake domain name that doesn't exists we will check the domain's A record.
                if(conf.blocked_servers.indexOf(ss[1]) == -1) {
                    // Let's check to see if the domain is valid otherwise we stop and move on.
                    checkDomainResolution(ss[1]).then((g) => {
                        if(s[0] in users && g == true) {
                            console.log(s[0]+" successfully received mail from "+p["from"]+" "+uuid_file+".mdata in their inbox.");
                            fs.writeFileSync("data/"+s[0]+"/inbox/"+uuid_file+".mdata", JSON.stringify(construction, null, '\t'));
                            u["folders"]["inbox"]["files"].push(uuid_file);

                            send(socket, {
                                id: "SENT_SUCCESS"
                            });
                        } else {
                            send(socket, {
                                id: "SENT_FAILED"
                            });
                        }

                        socket.terminate();
                    });
                } else {
                    console.log("They were blocked so there not to be trusted...");
                }
                break;
            case "SEND":
                console.log("We're sending a message to the server so be prepare for that!");
                if(socket.authed != false) {
                    var to = p["to"].split("@");
                    requestOutbox.push({
                        to: purifyString(to[0].toLowerCase())+"@"+to[1].toLowerCase() || "support@dragonrelay.net",
                        from: socket.userid+"@"+conf.settings.domain_root,
                        subject: p["subject"] || "Oops! I am being silent right now.",
                        message: p["content"] || "I'm sorry for the silence but not sorry at the same time :)",
                        attachments: p["attachments"] || [],
                        server_to: to[1].toLowerCase() || "dragonrelay.net",
                        reconnectError: null
                    });
                    send(socket, {
                        id: "MESSAGE_SENT"
                    })
                }
                break;
            case "LIST_FOLDERS":
                if(socket.authed != false) {
                    for(folders in users[socket.userid]["folders"]) {
                        send(socket, {
                            id: "GOT_FOLDER",
                            folder_id: folders,
                            alias: users[socket.userid]["folders"][folders]["alias"]
                        });
                    }
                }
                break;
            case "LIST_MESSAGES":
                var folder_id = p["folder_id"];

                if(socket.authed != false) {
                    for(var i=0; i<users[socket.userid]["folders"][folder_id]["files"].length; i++) {
                        var s=JSON.parse(fs.readFileSync("data/"+socket.userid+"/"+folder_id+"/"+users[socket.userid]["folders"][folder_id]["files"][i]+".mdata"));
                        send(socket, {
                            id: "GOT_MESSAGES",
                            to: s["to"],
                            from: s["from"],
                            subject: s["subject"],
                            sent_at: s["sent_at"],
                            read: s["has_read"],
                            uuid: users[socket.userid]["folders"][folder_id]["files"][i]
                        });
                    }
                }
                break;
            case "READ_MAIL":
                var folder_id = p["folder_id"];
                var no_err = true;

                try {
                    if(socket.authed != false) {
                        for(var i=0; i<users[socket.userid]["folders"][folder_id]["files"].length; i++) {
                            if(users[socket.userid]["folders"][folder_id]["files"][i] == p["mail_id"]) {
                                no_err = false;
                                var re = JSON.parse(fs.readFileSync("data/"+socket.userid+"/"+folder_id+"/"+users[socket.userid]["folders"][folder_id]["files"][i]+".mdata"));
                                re["has_read"] = true;
                                fs.writeFileSync("data/"+socket.userid+"/"+folder_id+"/"+users[socket.userid]["folders"][folder_id]["files"][i]+".mdata", JSON.stringify(re));

                                send(socket, {
                                    id: "MAIL_READ",
                                    mail: re
                                });
                            }
                        }

                        if(no_err == true) {
                            send(socket, {
                                MISSING_MAIL
                            });
                        }
                    }
                }catch(e){}
                break;
            case "DELETE_FOLDER":
                var folder_id = p["folder_id"];

                try {
                    if(socket.authed != false) {
                        if(folder_id == "inbox" || folder_id == "draft" || folder_id == "sent" || folder_id == "spam" || folder_id == "trash") {
                            send(socket, {
                                id: "DELETED_FAIL"
                            });
                        } else {
                            for(var i=0; i<users[socket.userid]["folders"][folder_id]["files"].length; i++) {
                                fs.unlinkSync("data/"+socket.userid+"/"+folder_id+"/"+users[socket.userid]["folders"][folder_id]["files"][i]+".mdata");
                            }
                            fs.unlinkSync("data/"+socket.userid+"/"+folder_id);
                            delete users[socket.userid]["folders"][folder_id];

                            send(socket, {
                                id: "DELETED_OK"
                            });
                        }
                    }
                }catch(e){}
                break;
            case "DELETE_MAIL":
                var folder_id = p["folder_id"];
                var mail_id = p["mail_id"];

                try {
                    if(socket.authed != false) {
                        if(folder_id != "trash") {
                            for(var i=0; i<users[socket.userid]["folders"][folder_id]["files"].length; i++) {
                                if(users[socket.userid]["folders"][folder_id]["files"][i] == mail_id) {
                                    users[socket.userid]["folders"]["trash"]["files"].push(users[socket.userid]["folders"][folder_id]["files"][i]);
                                    fs.copyFileSync("data/"+socket.userid+"/"+folder_id+"/"+users[socket.userid]["folders"][folder_id]["files"][i]+".mdata", "data/"+socket.userid+"/trash/"+users[socket.userid]["folders"][folder_id]["files"][i]+".mdata");
                                    fs.unlinkSync("data/"+socket.userid+"/"+folder_id+"/"+users[socket.userid]["folders"][folder_id]["files"][i]+".mdata");
                                    users[socket.userid]["folders"][folder_id]["files"].splice(i, 1);
                                    send(socket, {
                                        id: "MAIL_DELETED"
                                    });
                                }
                            }
                        }
                    }
                }catch(e){}
                break;
            case "MOVE_MAIL":
                var folder_id = p["folder_id"];
                var new_folder = p["new_folder"];
                var mail_id = p["mail_id"];

                try {
                    if(socket.authed != false) {
                        if(folder_id != new_folder) {
                            for(var i=0; i<users[socket.userid]["folders"][folder_id]["files"].length; i++) {
                                if(users[socket.userid]["folders"][folder_id]["files"][i] == mail_id) {
                                    users[socket.userid]["folders"][new_folder]["files"].push(users[socket.userid]["folders"][folder_id]["files"][i]);
                                    fs.copyFileSync("data/"+socket.userid+"/"+folder_id+"/"+users[socket.userid]["folders"][folder_id]["files"][i]+".mdata", "data/"+socket.userid+"/"+new_folder+"/"+users[socket.userid]["folders"][folder_id]["files"][i]+".mdata");
                                    fs.unlinkSync("data/"+socket.userid+"/"+folder_id+"/"+users[socket.userid]["folders"][folder_id]["files"][i]+".mdata");
                                    users[socket.userid]["folders"][folder_id]["files"].splice(i, 1);
                                    send(socket, {
                                        id: "MAIL_MOVED"
                                    });
                                }
                            }
                        } else {
                            send(socket, {
                                id: "MOVE_ERR"
                            });
                        }
                    }
                }catch(e){}
                break;
            case "MAKE_NEW_FOLDER":
                var folder_id = p["folder_id"];
                var folder_name = p["folder_name"];

                try {
                    if(socket.authed != false) {
                        if(folder_id in users[socket.userid]["folders"]) {
                            send(socket, {
                                id: "FOLDER_EXISTS"
                            });
                        } else {
                            users[socket.userid]["folders"][folder_id] = {
                                alias: folder_name,
                                files: []
                            };
                            fs.mkdirSync("data/"+socket.userid+"/"+folder_id);

                            send(socket, {
                                id: "NEW_FOLDER_CREATED",
                                folder_id: folder_id,
                                folder_name: folder_name
                            });
                        }
                    }
                }catch(e){}
                break;
            case "RENAME_FOLDER":
                var folder_id = p["folder_id"];
                var new_name = p["folder_name"];

                try {
                    if(socket.authed != false) {
                        if(folder_id in users[socket.userid]["folders"]) {
                            users[socket.userid]["folders"][folder_id]["alias"] = new_name;
                            send(socket, {
                                id: "RENAMED_FOLDER",
                                new_name: new_name
                            });
                        }
                    }
                }catch(e){}
                break;
            case "EMPTY_TRASH":
                if(socket.authed != false) {
                    for(var i=0; i<users[socket.userid]["folders"]["trash"]["files"].length; i++) {
                        fs.unlinkSync("data/"+socket.userid+"/trash/"+users[socket.userid]["folders"]["trash"]["files"][i]+".mdata");
                    }

                    users[socket.userid]["folders"]["trash"]["files"] = [];

                    send(socket, {
                        id: "TRASH_EMPTIED"
                    });
                }
                break;
            case "SAVE_DRAFT":
                var construction = {
                    to: p["to"],
                    from: socket.userid+"@"+conf.settings.domain_root,
                    subject: p["subject"],
                    message: p["content"],
                    attachments: p["attachments"] || [],
                    has_read: false,
                    sent_at: new Date().toLocaleString(),
                    drafted: true
                }

                if(socket.authed != false) {
                    var uuid_file = uuid.v4();
                    users[socket.userid]["folders"]["draft"]["files"].push(uuid_file);
                    fs.writeFileSync("data/"+socket.userid+"/draft/"+uuid_file+".mdata", JSON.stringify(construction, null, '\t'));

                    send(socket, {
                        id: "DRAFT_SAVED"
                    });
                }
                break;
            case "READ_DRAFT":
                var mail_id = p["mail_id"];
                
                if(socket.authed != false) {
                    for(var i=0; i<users[socket.userid]["folders"]["draft"]["files"].length; i++) {
                        if(users[socket.userid]["folders"]["draft"]["files"][i] == mail_id) {
                            var re = JSON.parse(fs.readFileSync("data/"+socket.userid+"/draft/"+users[socket.userid]["folders"]["draft"]["files"][i]+".mdata"));

                            send(socket, {
                                id: "DRAFT_READ",
                                mail: re,
                                uuid: users[socket.userid]["folders"]["draft"]["files"][i]
                            });
                        }
                    }
                }
                break;
            case "EDIT_DRAFT":
                var mail_id = p["mail_id"];

                if(socket.authed != false) {
                    for(var i=0; i<users[socket.userid]["folders"]["draft"]["files"].length; i++) {
                        if(users[socket.userid]["folders"]["draft"]["files"][i] == mail_id) {
                            var construction = {
                                to: p["to"],
                                from: socket.userid+"@"+conf.settings.domain_root,
                                subject: p["subject"],
                                message: p["content"],
                                attachments: p["attachments"] || [],
                                has_read: false,
                                sent_at: new Date().toLocaleString(),
                                drafted: true
                            }
                            fs.writeFileSync("data/"+socket.userid+"/draft/"+users[socket.userid]["folders"]["draft"]["files"][i]+".mdata", JSON.stringify(construction, null, '\t'));

                            send(socket, {
                                id: "DRAFT_EDITED"
                            })
                        }
                    }
                }
                break;
            case "SEND_DRAFT":
                var mail_id = p["mail_id"];

                if(socket.authed != false) {
                    for(var i=0; i<users[socket.userid]["folders"]["draft"]["files"].length; i++) {
                        if(users[socket.userid]["folders"]["draft"]["files"][i] == mail_id) {
                            var se = JSON.parse(fs.readFileSync("data/"+socket.userid+"/draft/"+users[socket.userid]["folders"]["draft"]["files"][i]+".mdata"));

                            requestOutbox.push({
                                to: se["to"],
                                from: se["from"],
                                subject: se["subject"],
                                message: se["message"],
                                attachments: se["attachments"],
                                server_to: se["to"].split("@")[1],
                                reconnectError: null
                            });
                            fs.unlinkSync("data/"+socket.userid+"/draft/"+users[socket.userid]["folders"]["draft"]["files"][i]+".mdata");
                            users[socket.userid]["folders"]["draft"]["files"].splice(i, 1);

                            send(socket, {
                                id: "DRAFT_SENT"
                            });
                        }
                    }
                }
                break;
            case "CMD":
                var us = p["username"];
                var pw = p["password"];
                var cmd = p["cmd"];

                if((us == conf.admin.username && pw == conf.admin.password) || users[socket.userid]["admin"] == true) {
                    switch(cmd) {
                        case "HELP":
                            var cheatsheet = [
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"SAVE_SERVER"} - Saves the server's data.`,
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"SERVER_STATUS"} - Views the server's version, users, currently processing outboxes and it's server name.`,
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"SERVER_RESTART"} - Saves and restarts the server.`,
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"USER_LIST"} - View's the list of clients that have registered on this server.`,
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"USER_RESET","userid":"bob"} - Completely resets the user's account except for password.`,
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"USER_INFO","userid":"bob"} - Outputs the user's information to the staff members.`,
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"USER_BAN","userid":"bob","reason":"broke my lawn.","days":30} - Bans the account from logging in and kicks the sockets logged in to the account.`,
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"USER_UNBAN","userid":"bob"} - Unbans the account so that the user can log back in.`,
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"USER_PASSWORD","userid":"bob","password":"pass123"} - Sets the user's password.`
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"CREATE_USER","userid":"bob","passwd":"pass123"} - Create a new user (if it doesn't exists) with a password that is hashed with sha256.`,
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"REMOVE_USER","userid":"bob"} - Completely removes the user's account making it available for anyone to register.`,
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"ANNOUCEMENT","subject":"IMPORTANT ANNOUNCEMENTS","message":"kool your system.} - Makes an announcement by sending an email to all users on the server and only on this server.`,
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"BLOCK_DOMAIN","domain_name":"naggers.net"} - Blocks the domain name so that users on this server do not receive emails from this blocked domain name.`,
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"UNBLOCK_DOMAIN","domain_name":"naggers.net"} - Unblocks the domain name so that users on this server will now receive new upcoming emails from this domain name.`,
                                `{"id":"CMD","username":"username here","password":"password here","cmd":"EDIT_MESSAGE","new_message":"HEDGEHOG STEW!"} - Replaces the current welcome message with the new message.`,
                            ];

                            for(var i=0; i<cheatsheet.length; i++) {
                                send(socket, [cheatsheet[i]]);
                            }
                            break;
                        case "SAVE_SERVER":
                            saveJson();

                            send(socket, ["The server's configuration and data was saved."]);
                            break;
                        case "SERVER_STATUS":
                            var banned = 0;
                            for(u in users) {
                                if(users[u]["banned"] == true) {banned++;}
                            }
                            send(socket, [
                                "Total Number of accounts registered is about "+Object.keys(users).length+" and about "+banned+" are banned.",
                                "Total Number of requests are currently processing "+requestOutbox.length+" of emails.",
                                "Total Number of blocked domains are at a size of "+conf.blocked_servers.length+" in the array.",
                                "The current domain root is "+conf.domain_root
                            ]);
                            break;
                        case "SERVER_RESTART":
                            saveJson();
                            setTimeout(function() {process.exit(1);},1000);
                            send(socket, [
                                "The server will restart/shutdown in a second."
                            ]);
                            break;
                        case "USER_LIST":
                            for(i in users) {
                                send(socket, [
                                    i + " is currently " + users[i].banned ? 'active' : 'banned from this server.'
                                ]);
                            };
                            break;
                        case "USER_RESET":
                            users[p["userid"]]["banned"] = false;
                            users[p["userid"]]["profile_imageurl"] = "";
                            users[p["userid"]]["folders"] = {
                                inbox: {
                                    alias: "Inbox", files: []
                                },
                                draft: {
                                    alias: "Draft", files: []
                                },
                                sent: {
                                    alias: "Sent",files: []
                                },
                                spam: {
                                    alias: "Spam",files: []
                                },
                                trash: {
                                    alias: "Trash",files: []
                                }
                            };
                            users[p["userid"]]["blocked"] = [];
                            users[p["userid"]]["contacts"] = [];
                            users[p["userid"]]["auto_reply"] = "";
                            users[p["userid"]]["info"] = {first_name: "Bob",last_name: "Smith",age: 37,website: "https://bobsmith.com/",about_yourself: "Hello I am bob and I like cheeseburgers.",youtube_channel: "",x_profile: "",facebook: "",instagram: "",tiktok: ""};
                            users[p["userid"]]["rep_pts"] = [];
                            users[p["userid"]]["admin"] = false;
                            send(socket, ["User "+p["userid"]+" has been reset back to default except for their password."]);
                            break;
                        case "USER_INFO":
                            if(p["userid"] in users) {
                                send(socket, [
                                    `This user is ` + (users[p["userid"]]["banned"] ? 'banned.' : 'not banned.'),
                                    `Their profile image is ${users[p["userid"]]["profile_imageurl"]}`,
                                    `They have blocked about ${users[p["userid"]]["blocked"].length} email addresses.`,
                                    `They have ${users[p["userid"]]["contacts"].length} contacts.`,
                                    `When ever they receive an email they will auto respond with "${users[p["userid"]]["auto_reply"]}".`,
                                    `They are ` + (users[p["userid"]]["admin"] ? "an administrator." : "not an administrator.")
                                ]);
                            } else {
                                send(socket, [
                                    `This user does not exists in the database.`
                                ]);
                            }
                            break;
                        case "USER_BAN":
                            if(p["userid"] in users) {
                                users[p["userid"]]["banned"] = true;
                                saveJson();

                                send(socket, [
                                    `User ${p["userid"]} was banned successfully.`
                                ]);
                            } else {
                                send(socket, [
                                    `This user does not exists in the database.`
                                ]);
                            }
                            break;
                        case "USER_UNBAN":
                            if(p["userid"] in users) {
                                users[p["userid"]]["banned"] = false;
                                saveJson();

                                send(socket, [
                                    `User ${p["userid"]} was unbanned successfully.`
                                ]);
                            } else {
                                send(socket, [
                                    `This user does not exists in the database.`
                                ]);
                            }
                            break;
                        case "USER_PASSWORD":
                            if(p["userid"] in users) {
                                users[p["userid"]]["password"] = sha256(p["password"]);
                                saveJson();

                                send(socket, [
                                    `User ${p["userid"]}'s password was changed.`
                                ]);
                            } else {
                                send(socket, [
                                    `This user does not exists in the database.`
                                ]);
                            }
                            break;
                        case "CREATE_USER":
                            if(p["userid"] in users) {
                                send(socket, [
                                    `This user already exists in the database.`
                                ]);
                            } else {
                                fs.mkdirSync("data/"+p["userid"]);
                                fs.mkdirSync("data/"+p["userid"]+"/inbox");
                                fs.mkdirSync("data/"+p["userid"]+"/draft");
                                fs.mkdirSync("data/"+p["userid"]+"/sent");
                                fs.mkdirSync("data/"+p["userid"]+"/spam");
                                fs.mkdirSync("data/"+p["userid"]+"/trash");
                                users[p["userid"]] = {
                                    password: sha256(p["password"]),
                                    banned: false,
                                    profile_imageurl: "",
                                    folders: {
                                        inbox: {
                                            alias: "Inbox",
                                            files: []
                                        },
                                        draft: {
                                            alias: "Draft",
                                            files: []
                                        },
                                        sent: {
                                            alias: "Sent",
                                            files: []
                                        },
                                        spam: {
                                            alias: "Spam",
                                            files: []
                                        },
                                        trash: {
                                            alias: "Trash",
                                            files: []
                                        }
                                    },
                                    blocked: [],
                                    contacts: [],
                                    auto_reply: "", // Can be blank for no auto response.,
                                    info: {
                                        first_name: "Bob",
                                        last_name: "Smith",
                                        age: 37,
                                        website: "https://bobsmith.com/",
                                        about_yourself: "Hello I am bob and I like cheeseburgers.",
                                        youtube_channel: "",
                                        x_profile: "",
                                        facebook: "",
                                        instagram: "",
                                        tiktok: ""
                                    },
                                    rep_pts: [], // Stored like so {"user": "alex", "rep": 1} or {"user":"john", "rep": -1}
                                    admin: false
                                }
                                
                                send(socket, [
                                    `You have successfully created ${p["userid"]} account.`
                                ]);
                            }
                            break;
                        case "REMOVE_USER":
                            if(p["userid"] in users) {
                                for(f in users[p["userid"]]["folders"]) {
                                    for(var i=0; i<users[p["userid"]]["folders"][f]["files"].length; i++) {
                                        fs.unlinkSync("data/"+p["userid"]+"/"+f+"/"+users[p["userid"]]["folders"][f]["files"][i]+".mdata");
                                    }
                                    fs.unlinkSync("data/"+p["userid"]+"/"+f);
                                    delete users[p["userid"]]["folders"][f];
                                }
                                fs.unlinkSync("data/"+p["userid"]);

                                delete users[p["userid"]];
                                saveJson();

                                send(socket, [
                                    `User ${p["userid"]} is deleted successfully.`
                                ]);
                            } else {
                                send(socket, [
                                    `This user doesn't exists in the database.`
                                ]);
                            }
                            break;
                        case "ANNOUCEMENT":
                            for(u in users) {
                                var uuid_file = uuid.v4();

                                var construction = {
                                    to: u+"@"+conf.settings.domain_root,
                                    from: "postmaster"+"@"+conf.settings.domain_root,
                                    subject: "[ANNOUNCEMENT]: "+p["subject"],
                                    message: p["content"],
                                    attachments: [],
                                    has_read: false,
                                    sent_at: new Date().toLocaleString(),
                                    drafted: false
                                }

                                fs.writeFileSync("data/"+u+"/inbox/"+uuid_file+".mdata", JSON.stringify(construction, null, '\t'));
                                users[u]["folders"]["inbox"]["files"].push(uuid_file);
                            }
                            saveJson();
                            break;
                        case "BLOCK_DOMAIN":
                            if(conf.blocked_servers.indexOf(p["domain_name"]) == -1) {
                                conf.blocked_servers.push(p["domain_name"]);
                                saveJson();

                                send(socket, [
                                    `Blocked ${p["domain_name"]} from users receiving emails from them.`
                                ]);
                            } else {
                                send(socket, [
                                    `This domain is already blocked so your users are protected against ${p["domain_name"]}.`
                                ])
                            }
                            break;
                        case "UNBLOCK_DOMAIN":
                            if(conf.blocked_servers.indexOf(p["domain_name"]) != -1) {
                                conf.blocked_servers.splice(conf.blocked_servers.indexOf(p["domain_name"]), 1);
                                saveJson();

                                send(socket, [
                                    `Unblocked ${p["domain_name"]} now users can receive emails from them.`
                                ]);
                            } else {
                                send(socket, [
                                    `This domain is already unblocked so your users are fine with receiving emails from ${p["domain_name"]}.`
                                ]);
                            }
                            break;
                        case "EDIT_MESSAGE":
                            conf.settings.welcomeMessage = p["new_message"];

                            send(socket, [
                                `New welcome message was set. Users will now notice this new message when they log in.`
                            ]);
                            break;
                    }
                }
                break;
        }
    })
});

server.on("listening", () => {
    if(conf.settings.use_ssl == false) {
        console.log("Running email server on ws://*.*.*.*:"+PLAIN_PORT);
    } else {
        console.log("Running (SSL) email server on wss://*.*.*.*:"+SSL_PORT);
    }
})

const socketServer = dgram.createSocket('udp4');

socketServer.on("message", (msg, rinfo) => {
    try {var p = JSON.parse(msg.toString("utf8"));}catch(e){var p={id:"unknown"};}

    switch(p["id"]) {
        case "ASKINFO":
            var s = {
                id: "GOTINFO",
                servername: conf.settings.serverName,
                ssl_req: conf.settings.use_ssl
            };

            socketServer.send(JSON.stringify(s), rinfo.port, rinfo.address);
            break;
        case "GOTINFO":
            //{"id":"GOTINFO","servername":"StellarMail","ssl_req":false}
            clearTimeout(requestOutbox[0]["reconnectError"]); // Clear it since we're able to communicate together.
            console.log("Received an answer back from "+requestOutbox[0]["server_to"]);
            console.log("The server's name is "+p["servername"]);
            if(p["ssl_req"] == true) {
                console.log("Setting up a SSL connection with "+requestOutbox[0]["server_to"]+":"+SSL_PORT+"...");
                var serverConn = new WebSocket("wss://"+requestOutbox[0]["server_to"]+":"+SSL_PORT);
                serverConn.box = requestOutbox[0];

                serverConn.on("open", () => {
                    console.log("Connected! Sending outbox request to the server...");
                    var s = serverConn.box["to"].split("@");
                    serverConn.send(JSON.stringify({
                        id: "OUTBOX",
                        to: serverConn.box["to"],
                        from: serverConn.box["from"],
                        subject: serverConn.box["subject"],
                        content: serverConn.box["message"],
                        attachments: serverConn.box["attachments"]
                    }));
                });

                serverConn.on("close", () => {
                    if(requestOutbox.length != 1) {
                        console.log("Finished with the request now moving on to the next one...");
                    } else {
                        console.log("Finished with the request and no more requests are out which means I am done.");
                    }
                    requestOutbox.splice(0, 1);
                    currentlyProcessingRequest = false;
                });

                serverConn.on("message", (msg) => {
                    var p=JSON.parse(msg.toString("utf8"));

                    switch(p["id"]) {
                        case "SENT_SUCCESS":
                            console.log("Server had sent the request successfully. Now creating a copy of the email to the sender...");
                            var u = users[serverConn.box["from"].split("@")[0]];

                            var construction = {
                                to: serverConn.box["to"],
                                from: serverConn.box["from"],
                                subject: serverConn.box["subject"],
                                message: serverConn.box["message"],
                                attachments: serverConn.box["attachments"],
                                has_read: false,
                                sent_at: new Date().toLocaleString()
                            }

                            var uuid_file = uuid.v4();

                            fs.writeFileSync("data/"+serverConn.box["from"].split("@")[0]+"/sent/"+uuid_file+".mdata", JSON.stringify(construction, null, '\t'));
                            u["folders"]["sent"]["files"].push(uuid_file);
                            break;
                        case "SENT_FAILED":
                            console.log("Server was unable to find the user...");
                            break;
                    }
                });
            } else {
                if(conf.settings.enforce_ssl_connection == true) {
                    var u = users[serverConn.box["from"].split("@")[0]];

                    var construction = {
                        to: serverConn.box["to"],
                        from: serverConn.box["from"],
                        subject: "Mailbox Server Error!",
                        message: "The server has SSL enforcement turned on so your mail wasn't delivered because the server you attempted to send mail to does not have SSL enabled. Ask the administrator of the email server you tried to send to setup SSL.",
                        attachments: [],
                        has_read: false,
                        sent_at: new Date().toLocaleString()
                    }

                    var uuid_file = uuid.v4();
                                
                    fs.writeFileSync("data/"+serverConn.box["from"].split("@")[0]+"/sent/"+uuid_file+".mdata", JSON.stringify(construction, null, '\t'));
                    u["folders"]["inbox"]["files"].push(uuid_file);

                    requestOutbox.splice(0, 1);
                    currentlyProcessingRequest = false;
                } else {
                    var serverConn = new WebSocket("ws://"+requestOutbox[0]["server_to"]+":"+PLAIN_PORT);
                    console.log("Setting up a PLAIN connection with "+requestOutbox[0]["server_to"]+":"+PLAIN_PORT+"...");

                    serverConn.box = requestOutbox[0];

                    serverConn.on("open", () => {
                        console.log("Connected! Sending outbox request to the server...");
                        serverConn.send(JSON.stringify({
                            id: "OUTBOX",
                            to: serverConn.box["to"],
                            from: serverConn.box["from"],
                            subject: serverConn.box["subject"],
                            content: serverConn.box["message"],
                            attachments: serverConn.box["attachments"]
                        }));
                    });

                    serverConn.on("close", () => {
                        if(requestOutbox.length != 1) {
                            console.log("Finished with the request now moving on to the next one...");
                        } else {
                            console.log("Finished with the request and no more requests are out which means I am done.");
                        }
                        requestOutbox.splice(0, 1);
                        currentlyProcessingRequest = false;
                    });

                    serverConn.on("message", (msg) => {
                        var p=JSON.parse(msg.toString("utf8"));

                        switch(p["id"]) {
                            case "SENT_SUCCESS":
                                console.log("Server had sent the request successfully. Now creating a copy of the email to the sender...");
                                var u = users[serverConn.box["from"].split("@")[0]];

                                var construction = {
                                    to: serverConn.box["to"],
                                    from: serverConn.box["from"],
                                    subject: serverConn.box["subject"],
                                    message: serverConn.box["message"],
                                    attachments: serverConn.box["attachments"],
                                    has_read: false,
                                    sent_at: new Date().toLocaleString()
                                }

                                var uuid_file = uuid.v4();
                                
                                fs.writeFileSync("data/"+serverConn.box["from"].split("@")[0]+"/sent/"+uuid_file+".mdata", JSON.stringify(construction, null, '\t'));
                                u["folders"]["sent"]["files"].push(uuid_file);
                                break;
                        }
                    });
                }
            }
            break;
    }
});

socketServer.on("listening", () => {
    console.log("Listening on :"+ASK_PORT+" for requests on asking the server...");
});

socketServer.bind(ASK_PORT);

process.on('SIGINT', () => {
    console.log('Ctrl+C detected! Saving file first...');
    saveJson();
    process.exit();
});

process.on('SIGTERM', () => {
    console.log('Ctrl+C detected! Saving file first...');
    saveJson();
    process.exit();
});