import { expect } from 'chai'
import { EventEmitter } from 'node:events'
import Module from 'node:module'
import type { BLEAdvertisement } from '@signalk/server-api'
import { LocalBLEProvider } from '../src/api/ble/localProvider'

/**
 * BlueZ reports a device's Name in the initial property read and afterwards
 * only when it changes, while RSSI and ManufacturerData change with every
 * advertisement. The local provider must therefore keep the name it read and
 * send it with every advertisement, including when the initial read happened
 * before anyone subscribed, as it does at server start.
 */

const ADAPTER = 'hci0'
const MAX_SLOTS = 3
// Enough event-loop turns for the provider's pending D-Bus work to run
const SETTLE_TURNS = 20

const SENSOR = 'D5:9E:F7:D6:F6:92'

const settle = async () => {
  for (let i = 0; i < SETTLE_TURNS; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

// What the provider uses of a node-ble Device: the Properties proxy for the
// initial GetAll, and the helper that relays PropertiesChanged.
class FakeDevice {
  readonly helper: EventEmitter & {
    _prepare: () => Promise<void>
    removeListeners: () => void
  }
  readonly _propsProxy: {
    GetAll: (iface: string) => Promise<Record<string, unknown>>
  }

  constructor(props: Record<string, unknown>) {
    const emitter = new EventEmitter()
    this.helper = Object.assign(emitter, {
      _prepare: async () => undefined,
      removeListeners: () => {
        emitter.removeAllListeners()
      }
    })
    this._propsProxy = { GetAll: async () => props }
  }

  // BlueZ PropertiesChanged carrying only what changed
  change(props: Record<string, unknown>) {
    this.helper.emit('PropertiesChanged', props)
  }
}

type Requirer = (this: unknown, id: string, ...rest: unknown[]) => unknown
const patchable = Module as unknown as { prototype: { require: Requirer } }
const realRequire: Requirer = patchable.prototype.require

const startProvider = async (devices: Map<string, FakeDevice>) => {
  const adapter = {
    isPowered: async () => true,
    devices: async () => [...devices.keys()],
    helper: { callMethod: async () => undefined },
    waitDevice: async (mac: string) => devices.get(mac)
  }
  const provider = new LocalBLEProvider(ADAPTER, MAX_SLOTS)
  patchable.prototype.require = function (
    this: unknown,
    id: string,
    ...rest: unknown[]
  ) {
    if (id === '@naugehyde/node-ble') {
      return {
        createBluetooth: () => ({
          bluetooth: { dbus: {}, getAdapter: async () => adapter },
          destroy: () => undefined
        })
      }
    }
    return realRequire.call(this, id, ...rest)
  }
  let ready: Promise<void>
  try {
    // node-ble is required synchronously at the start of init()
    ready = provider.init()
  } finally {
    patchable.prototype.require = realRequire
  }
  await ready
  return provider
}

const manufacturerData = (hex: string) => ({
  value: { 0x02e1: { value: Buffer.from(hex, 'hex') } }
})

describe('Local BLE provider advertised names', () => {
  let provider: LocalBLEProvider | undefined

  afterEach(() => {
    provider?.shutdown()
    provider = undefined
  })

  it('keeps the name on advertisements after the initial read', async () => {
    const sensor = new FakeDevice({
      Name: { value: 'Starter Battery' },
      RSSI: { value: -70 },
      ManufacturerData: manufacturerData('1000a5a302')
    })
    provider = await startProvider(new Map([[SENSOR, sensor]]))
    const received: BLEAdvertisement[] = []
    provider.onAdvertisement((adv) => received.push(adv))
    await provider.startDiscovery()
    await settle()

    sensor.change({ RSSI: { value: -72 } })
    sensor.change({ ManufacturerData: manufacturerData('1000a5a302ab') })

    expect(received.map((adv) => adv.name)).to.deep.equal([
      'Starter Battery',
      'Starter Battery',
      'Starter Battery'
    ])
  })

  it('keeps a name read before anyone subscribed', async () => {
    const sensor = new FakeDevice({
      Name: { value: 'Starter Battery' },
      RSSI: { value: -70 }
    })
    provider = await startProvider(new Map([[SENSOR, sensor]]))
    await provider.startDiscovery()
    await settle()

    const received: BLEAdvertisement[] = []
    provider.onAdvertisement((adv) => received.push(adv))
    sensor.change({ RSSI: { value: -71 } })

    expect(received).to.have.length(1)
    expect(received[0].name).to.equal('Starter Battery')
  })

  it('follows a name that changes', async () => {
    const sensor = new FakeDevice({
      Name: { value: 'Old' },
      RSSI: { value: -70 }
    })
    provider = await startProvider(new Map([[SENSOR, sensor]]))
    const received: BLEAdvertisement[] = []
    provider.onAdvertisement((adv) => received.push(adv))
    await provider.startDiscovery()
    await settle()

    sensor.change({ Name: { value: 'New' }, RSSI: { value: -71 } })
    sensor.change({ RSSI: { value: -72 } })

    expect(received.map((adv) => adv.name)).to.deep.equal(['Old', 'New', 'New'])
  })

  it('sends no name for a device that advertises none', async () => {
    const phone = new FakeDevice({ RSSI: { value: -60 } })
    provider = await startProvider(new Map([[SENSOR, phone]]))
    const received: BLEAdvertisement[] = []
    provider.onAdvertisement((adv) => received.push(adv))
    await provider.startDiscovery()
    await settle()
    phone.change({ RSSI: { value: -61 } })

    expect(received.map((adv) => adv.name)).to.deep.equal([
      undefined,
      undefined
    ])
  })
})
