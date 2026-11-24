// db.js
const { MongoClient } = require("mongodb");
const {
  initAuthCreds,
  BufferJSON,
  proto,
} = require("@whiskeysockets/baileys");
const CONFIG = require("./config");

let mongoClient = null;

async function getMongo() {
  if (!mongoClient) {
    mongoClient = new MongoClient(CONFIG.MONGO_URI);
    await mongoClient.connect();
  }
  return mongoClient;
}

async function useMongoDBAuthState(collection, sessionId) {
  const writeData = async (data, id) => {
    try {
      await collection.updateOne(
        { _id: id },
        { $set: { data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) } },
        { upsert: true }
      );
    } catch (e) {
      console.error("writeData:", e.message);
    }
  };

  const readData = async (id) => {
    try {
      const doc = await collection.findOne({ _id: id });
      if (doc && doc.data !== undefined && doc.data !== null) {
        return JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver);
      }
      return null;
    } catch {
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await collection.deleteOne({ _id: id });
    } catch {}
  };

  const credsId = `${sessionId}:creds`;
  const creds = (await readData(credsId)) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${sessionId}:${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${sessionId}:${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData(creds, credsId);
    },
  };
}

async function getSessionConfig(sessionId) {
  const client = await getMongo();
  const doc = await client
    .db(CONFIG.DB_NAME)
    .collection("sessionConfigs")
    .findOne({ _id: sessionId });
  return {
    botName: doc?.botName || CONFIG.BOT_NAME,
    footer: doc?.footer || CONFIG.FOOTER,
    version: doc?.version || CONFIG.VERSION,
    prefix: doc?.prefix || CONFIG.PREFIX,
    ownerNumber: doc?.ownerNumber || CONFIG.OWNER_NUMBER,
    ownerName: doc?.ownerName || CONFIG.OWNER_NAME,
    workMode: (doc?.workMode || CONFIG.WORK_MODE).toLowerCase(),
    overrides: doc?.overrides || {},
    global: CONFIG,
  };
}

async function saveSessionConfig(sessionId, patch) {
  const client = await getMongo();
  await client
    .db(CONFIG.DB_NAME)
    .collection("sessionConfigs")
    .updateOne({ _id: sessionId }, { $set: patch }, { upsert: true });
}

async function wipeSession(sessionId) {
  const client = await getMongo();
  await client
    .db(CONFIG.DB_NAME)
    .collection("authState")
    .deleteMany({ _id: { $regex: `^${sessionId}:` } });
  await client
    .db(CONFIG.DB_NAME)
    .collection("sessionConfigs")
    .deleteOne({ _id: sessionId });
}

module.exports = {
  getMongo,
  useMongoDBAuthState,
  getSessionConfig,
  saveSessionConfig,
  wipeSession,
};
