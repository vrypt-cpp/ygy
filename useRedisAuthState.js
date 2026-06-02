import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys'

const serialize = (value) => JSON.stringify(value, BufferJSON.replacer)

const deserialize = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw, BufferJSON.reviver)
  } catch {
    return null
  }
}

export async function useRedisAuthState(redis, sessionId, opts = {}) {
  const { credsExpirySec, keysExpirySec } = opts

  const credsKey = () => `${sessionId}:creds`
  const hashKey = (type) => `${sessionId}:keys:${type}`

  const readCreds = async () => deserialize(await redis.get(credsKey()))

  const writeCreds = async (creds) => {
    if (credsExpirySec) {
      await redis.set(credsKey(), serialize(creds), { EX: credsExpirySec })
    } else {
      await redis.set(credsKey(), serialize(creds))
    }
  }

  const readKeys = async (type, ids) => {
    if (!ids.length) return {}
    const values = await redis.hmGet(hashKey(type), ids)
    const result = {}
    for (let i = 0; i < ids.length; i++) {
      const val = deserialize(values[i])
      if (val !== null) result[ids[i]] = val
    }
    return result
  }

  const writeKeys = async (type, entries) => {
    const hKey = hashKey(type)
    const toSet = {}
    const toDel = []
    for (const [id, value] of Object.entries(entries)) {
      if (value === null || value === undefined) {
        toDel.push(id)
      } else {
        toSet[id] = serialize(value)
      }
    }
    if (Object.keys(toSet).length) {
      await redis.hSet(hKey, toSet)
      if (keysExpirySec) await redis.expire(hKey, keysExpirySec)
    }
    if (toDel.length) await redis.hDel(hKey, toDel)
  }

  const creds = (await readCreds()) ?? initAuthCreds()

  const state = {
    creds,
    keys: {
      async get(type, ids) {
        return readKeys(type, ids)
      },
      async set(data) {
        await Promise.all(
          Object.entries(data)
            .filter(([, entries]) => entries && typeof entries === 'object')
            .map(([type, entries]) => writeKeys(type, entries))
        )
      },
      async clear() {
        const keyTypes = [
          'pre-key',
          'session',
          'sender-key',
          'sender-key-memory',
          'app-state-sync-key',
          'app-state-sync-version',
          'lid-mapping',
          'device-list',
          'tctoken',
        ]
        await redis.del([...keyTypes.map(hashKey), credsKey()])
      },
    },
  }

  const saveCreds = async () => writeCreds(state.creds)
  const clearState = async () => state.keys.clear()

  return { state, saveCreds, clearState }
}

export default useRedisAuthState
