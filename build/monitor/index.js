const restify = require("restify");
const corsMiddleware = require("restify-cors-middleware");
const fs = require("fs");
const supervisord = require('supervisord');
const supervisordclient = supervisord.connect('http://localhost:9001');
const ini = require('ini');

const JSONdb = require('simple-json-db');
const dbFile = '/package/data/config.json';
const db = new JSONdb(dbFile);

console.log("Monitor starting...");

// defaults
const defaults =
{
    "DELEGATION_FEE_PERCENT": 10,
    "MIN_DELEGATION_AMOUNT": 100,
    "BACKUP_REQUIRED": true,
};

const server = restify.createServer({
    name: "MONITOR",
    version: "1.0.0"
});

const cors = corsMiddleware({
    preflightMaxAge: 5, //Optional
    origins: [
        /^http:\/\/localhost(:[\d]+)?$/,
        "http://*.dappnode.eth:81",
    ]
});

server.pre(cors.preflight);
server.use(cors.actual);
server.use(restify.plugins.bodyParser());

server.get("/getenv", (req, res) => {
    res.send(200, db.JSON());
});

server.post("/setenv", async (req, res) => {
    if (!req.body) {
        res.send(400);
    }

    Object.keys(req.body).map(async (key) => {
        const displayVal = (key.toString().includes("PRIVATE")) ? "(hidden)" : req.body[key]
        console.log(`${key}=>${displayVal}`);
        await db.set(key, req.body[key]);
    })

    restartQtum();

    res.send(200, db.JSON());
});

server.post("/restartQtum", async (req, res) => {
    restartQtum();
    res.send(200);
});

server.get('/*', restify.plugins.serveStaticFiles(`${__dirname}/wizard`, {
    maxAge: 1, // this is in millisecs
    etag: false,
}));

const syncQtumConf = () => {
    const qtumConfigPath = '/package/data/qtum.conf';
    const config = ini.parse(fs.readFileSync(qtumConfigPath, 'utf-8'));
    const envVariablesToQtumConfigVariables = {
        "DELEGATION_FEE_PERCENT": "stakingminfee",
        "MIN_DELEGATION_AMOUNT": "stakingminutxovalue",
    };

    for (const [envVarName, qtumConfigVarName] of Object.entries(envVariablesToQtumConfigVariables)) {
        config[qtumConfigVarName] = db.get(envVarName);
    }

    fs.writeFileSync(qtumConfigPath, ini.stringify(config));
}

const restartQtum = () => {
    syncQtumConf();
    const service = "qtum";
    supervisordclient.stopProcess(service, (err, result) => {
        if (err) {
            console.log(`error stopping service ${service}`, err);
        }

        supervisordclient.startProcess(service, (err, result) => {
            if (err) {
                console.log(`error starting service ${service}`, err);
            }
            console.log(`successfully started service ${service}`);
        });
    });
}

const censor = (config) => {
    // remove sensitive info
    return Object.keys(config).map((key) => {
        let r = {};
        let val = (key === "PRIVATE_KEY" && config.key !== "") ? "***[censored]***" : config[key];
        r[key] = val;
        return (r);
    })
}

const main = async () => {
    // set default values
    Object.keys(defaults).map((key) => {
        const val = defaults[key];
        if (db.get(key) === undefined) {
            db.set(key, val);
        }
    });

    // on startup - check if config file exists & start service if so
    if (fs.existsSync(dbFile)) {
        const missingKeys = Object.keys(defaults).reduce((accum, key) => {
            if (db.get(key) === undefined || db.get(key) === "") {
                let r = {};
                r[key] = db.get(key);
                accum.push(r);
            }
            return accum;
        }, []);

        if (missingKeys.length > 0) {
            console.log(`Some keys are missing`);
            console.log(`missing:`);
            console.log(missingKeys);
            console.log(`current config:`);
            console.log(censor(db.JSON()));
        } else {
            console.log(`A config file exists - attemtping to start service`);
            console.log(censor(db.JSON()));
            restartQtum();
        }
    }

    server.listen(3000, function () {
        console.log("%s listening at %s", server.name, server.url);
    });
}

main();