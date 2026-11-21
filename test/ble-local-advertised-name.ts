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
 *
 * The provider is driven through the real node-ble Device over a fake system
 * bus, so the test exercises the same property calls as BlueZ would see.
 */

const ADAPTER = 'hci0'
const MAX_SLOTS = 3
const DEVICE_IFACE = 'org.bluez.Device1'
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties'
const BUS_DAEMON = 'org.freedesktop.DBus'
// Enough event-loop turns for the provider's pending D-Bus work to run
const SETTLE_TURNS = 20

const SENSOR = 'D5:9E:F7:D6:F6:92'

const nodeOf = (mac: string) => `dev_${mac.replace(/:/g, '_')}`
const pathOf = (mac: string) => `/org/bluez/${ADAPTER}/${nodeOf(mac)}`

// D-Bus values arrive wrapped in Variants
const variant = (value: unknown) => ({ value })
const victronData = (hex: string) =>
  variant({ 0x02e1: variant(Buffer.from(hex, 'hex')) })

// A system bus holding the org.bluez.Device1 properties of each device. Its
// Properties proxies answer GetAll and relay PropertiesChanged, as BlueZ does.
class FakeBus {
  private readonly properties = new Map<string, Record<string, unknown>>()
  private readonly proxies = new Map<string, EventEmitter[]>()

  addDevice(mac: string, props: Record<string, unknown>) {
    this.properties.set(pathOf(mac), props)
  }

  // BlueZ PropertiesChanged carrying only what changed
  change(mac: string, changed: Record<string, unknown>) {
    Object.assign(this.properties.get(pathOf(mac)) ?? {}, changed)
    for (const proxy of this.proxies.get(pathOf(mac)) ?? []) {
      proxy.emit('PropertiesChanged', DEVICE_IFACE, changed, [])
    }
  }

  async getProxyObject(service: string, path: string) {
    if (service === BUS_DAEMON) {
      return { nodes: [], getInterface: () => new EventEmitter() }
    }
    return {
      nodes: [],
      getInterface: (iface: string) => {
        if (iface !== PROPERTIES_IFACE) return {}
        const proxy = Object.assign(new EventEmitter(), {
          GetAll: async (wanted: string) =>
            wanted === DEVICE_IFACE ? { ...this.properties.get(path) } : {}
        })
        this.proxies.set(path, [...(this.proxies.get(path) ?? []), proxy])
        return proxy
      }
    }
  }
}

type Requirer = (this: unknown, id: string, ...rest: unknown[]) => unknown
const patchable = Module as unknown as { prototype: { require: Requirer } }
const realRequire: Requirer = patchable.prototype.require

type DeviceCtor = new (dbus: FakeBus, adapter: string, device: string) => object
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Device = require('@naugehyde/node-ble/src/Device') as DeviceCtor

const settle = async () => {
  for (let i = 0; i < SETTLE_TURNS; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const startProvider = async (bus: FakeBus, macs: string[]) => {
  const adapter = {
    isPowered: async () => true,
    devices: async () => macs,
    helper: { callMethod: async () => undefined },
    // A fresh Device per lookup, as node-ble's Adapter.waitDevice() returns
    waitDevice: async (mac: string) => new Device(bus, ADAPTER, nodeOf(mac))
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
          bluetooth: { dbus: bus, getAdapter: async () => adapter },
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

describe('Local BLE provider advertised names', () => {
  let provider: LocalBLEProvider | undefined

  afterEach(() => {
    provider?.shutdown()
    provider = undefined
  })

  it('reads the name and manufacturer data in the initial read', async () => {
    const bus = new FakeBus()
    bus.addDevice(SENSOR, {
      Name: variant('Starter Battery'),
      RSSI: variant(-70),
      ManufacturerData: victronData('1000a5a302')
    })
    provider = await startProvider(bus, [SENSOR])
    const received: BLEAdvertisement[] = []
    provider.onAdvertisement((adv) => received.push(adv))
    await provider.startDiscovery()
    await settle()

    expect(received).to.have.length(1)
    expect(received[0].name).to.equal('Starter Battery')
    expect(received[0].rssi).to.equal(-70)
    expect(received[0].manufacturerData).to.deep.equal({ 737: '1000a5a302' })
  })

  it('keeps the name on advertisements after the initial read', async () => {
    const bus = new FakeBus()
    bus.addDevice(SENSOR, {
      Name: variant('Starter Battery'),
      RSSI: variant(-70),
      ManufacturerData: victronData('1000a5a302')
    })
    provider = await startProvider(bus, [SENSOR])
    const received: BLEAdvertisement[] = []
    provider.onAdvertisement((adv) => received.push(adv))
    await provider.startDiscovery()
    await settle()

    bus.change(SENSOR, { RSSI: variant(-72) })
    bus.change(SENSOR, { ManufacturerData: victronData('1000a5a302ab') })

    expect(received.map((adv) => adv.name)).to.deep.equal([
      'Starter Battery',
      'Starter Battery',
      'Starter Battery'
    ])
  })

  it('keeps a name read before anyone subscribed', async () => {
    const bus = new FakeBus()
    bus.addDevice(SENSOR, {
      Name: variant('Starter Battery'),
      RSSI: variant(-70)
    })
    provider = await startProvider(bus, [SENSOR])
    await provider.startDiscovery()
    await settle()

    const received: BLEAdvertisement[] = []
    provider.onAdvertisement((adv) => received.push(adv))
    bus.change(SENSOR, { RSSI: variant(-71) })

    expect(received).to.have.length(1)
    expect(received[0].name).to.equal('Starter Battery')
  })

  it('follows a name that changes', async () => {
    const bus = new FakeBus()
    bus.addDevice(SENSOR, { Name: variant('Old'), RSSI: variant(-70) })
    provider = await startProvider(bus, [SENSOR])
    const received: BLEAdvertisement[] = []
    provider.onAdvertisement((adv) => received.push(adv))
    await provider.startDiscovery()
    await settle()

    bus.change(SENSOR, { Name: variant('New'), RSSI: variant(-71) })
    bus.change(SENSOR, { RSSI: variant(-72) })

    expect(received.map((adv) => adv.name)).to.deep.equal(['Old', 'New', 'New'])
  })

  it('sends no name for a device that advertises none', async () => {
    const bus = new FakeBus()
    bus.addDevice(SENSOR, { RSSI: variant(-60) })
    provider = await startProvider(bus, [SENSOR])
    const received: BLEAdvertisement[] = []
    provider.onAdvertisement((adv) => received.push(adv))
    await provider.startDiscovery()
    await settle()
    bus.change(SENSOR, { RSSI: variant(-61) })

    expect(received.map((adv) => adv.name)).to.deep.equal([
      undefined,
      undefined
    ])
  })
})
