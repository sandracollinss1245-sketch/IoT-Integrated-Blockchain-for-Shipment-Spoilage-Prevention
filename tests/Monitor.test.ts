// tests/monitor.test.ts
import { describe, expect, it, beforeEach, vi } from "vitest";

// === Type Definitions ===
interface ShipmentConfig {
  minTemp: number;
  maxTemp: number;
  maxHandling: number;
  owner: string;
  active: boolean;
}

interface SensorLog {
  timestamp: number | null;
  temperature: number;
  handling: number;
  blockHeight: number;
}

interface Violation {
  shipmentId: number;
  logIndex: number;
  violationType: string;
  value: number;
  threshold: number;
  timestamp: number;
  resolved: boolean;
}

interface ClarityOk<T> {
  ok: true;
  value: T;
}

interface ClarityErr {
  ok: false;
  value: number;
}

type ClarityResult<T> = ClarityOk<T> | ClarityErr;

// === Mock Monitor Contract ===
class MonitorMock {
  private shipmentConfig = new Map<number, ShipmentConfig>();
  private sensorLogs = new Map<string, SensorLog>(); // key: `${shipmentId}-${index}`
  private violations = new Map<number, Violation>();
  private logCounter = 0;
  private violationCounter = 0;
  private currentBlockHeight = 1000;
  private currentTime = Date.now();

  // Mock block info
  private getBlockInfoTime(): number | null {
    return this.currentTime;
  }

  private advanceBlock() {
    this.currentBlockHeight++;
    this.currentTime += 60_000; // +1 min
  }

  // === Public Functions ===
  registerShipment(
    caller: string,
    shipmentId: number,
    minTemp: number,
    maxTemp: number,
    maxHandling: number
  ): ClarityResult<boolean> {
    if (maxTemp < minTemp || maxHandling <= 0) {
      return { ok: false, value: 105 }; // ERR_INVALID_THRESHOLD
    }
    this.shipmentConfig.set(shipmentId, {
      minTemp,
      maxTemp,
      maxHandling,
      owner: caller,
      active: true,
    });
    return { ok: true, value: true };
  }

  deactivateShipment(caller: string, shipmentId: number): ClarityResult<boolean> {
    const config = this.shipmentConfig.get(shipmentId);
    if (!config) return { ok: false, value: 100 };
    if (config.owner !== caller) return { ok: false, value: 104 };
    this.shipmentConfig.set(shipmentId, { ...config, active: false });
    return { ok: true, value: true };
  }

  submitSensorData(
    shipmentId: number,
    temperature: number,
    handling: number
  ): ClarityResult<number> {
    const config = this.shipmentConfig.get(shipmentId);
    if (!config || !config.active) return { ok: false, value: 100 };

    if (this.logCounter >= 500) return { ok: false, value: 101 };

    const index = this.logCounter++;
    const key = `${shipmentId}-${index}`;

    this.sensorLogs.set(key, {
      timestamp: this.getBlockInfoTime(),
      temperature,
      handling,
      blockHeight: this.currentBlockHeight,
    });

    // Violation detection
    if (temperature < config.minTemp) {
      this.recordViolation(shipmentId, index, "temp-low", temperature, config.minTemp);
    }
    if (temperature > config.maxTemp) {
      this.recordViolation(shipmentId, index, "temp-high", temperature, config.maxTemp);
    }
    if (handling > config.maxHandling) {
      this.recordViolation(shipmentId, index, "handling", handling, config.maxHandling);
    }

    this.advanceBlock();
    return { ok: true, value: index };
  }

  private recordViolation(
    shipmentId: number,
    logIndex: number,
    type: string,
    value: number,
    threshold: number
  ) {
    const vid = this.violationCounter++;
    this.violations.set(vid, {
      shipmentId,
      logIndex,
      violationType: type,
      value,
      threshold,
      timestamp: this.currentBlockHeight,
      resolved: false,
    });
  }

  resolveViolation(violationId: number): ClarityResult<boolean> {
    const v = this.violations.get(violationId);
    if (!v) return { ok: false, value: 100 };
    if (v.resolved) return { ok: false, value: 103 };
    this.violations.set(violationId, { ...v, resolved: true });
    return { ok: true, value: true };
  }

  // === Read-only ===
  getShipmentConfig(shipmentId: number): ClarityResult<ShipmentConfig | null> {
    return { ok: true, value: this.shipmentConfig.get(shipmentId) ?? null };
  }

  getSensorLog(shipmentId: number, index: number): ClarityResult<SensorLog | null> {
    return { ok: true, value: this.sensorLogs.get(`${shipmentId}-${index}`) ?? null };
  }

  getViolation(violationId: number): ClarityResult<Violation | null> {
    return { ok: true, value: this.violations.get(violationId) ?? null };
  }

  getViolationsByShipment(shipmentId: number): ClarityResult<number[]> {
    const vids: number[] = [];
    for (const [vid, v] of this.violations.entries()) {
      if (v.shipmentId === shipmentId && vids.length < 100) {
        vids.push(vid);
      }
    }
    return { ok: true, value: vids };
  }

  hasActiveViolations(shipmentId: number): ClarityResult<boolean> {
    const config = this.shipmentConfig.get(shipmentId);
    if (!config || !config.active) return { ok: true, value: false };
    for (const v of this.violations.values()) {
      if (v.shipmentId === shipmentId && !v.resolved) return { ok: true, value: true };
    }
    return { ok: true, value: false };
  }
}

// === Test Accounts ===
const accounts = {
  deployer: "ST1PQHQKV0RJXZFY1DGX8D8J5S7M7A1A1A1A1A1A1",
  shipper: "ST2CYZ9J3J3J3J3J3J3J3J3J3J3J3J3J3J3J3J3J3J3",
  oracle: "ST3NBRSJD0JQD0JQD0JQD0JQD0JQD0JQD0JQD0JQD0J",
};

// === Test Suite ===
describe("Monitor.clar - Core Violation Detection Engine", () => {
  let monitor: MonitorMock;

  beforeEach(() => {
    monitor = new MonitorMock();
    vi.resetAllMocks();
  });

  it("should register a valid shipment with correct thresholds", () => {
    const result = monitor.registerShipment(
      accounts.shipper,
      1,
      200,    // 2.00°C
      800,    // 8.00°C
      1000    // 10.00g
    );
    expect(result).toEqual({ ok: true, value: true });

    const config = monitor.getShipmentConfig(1);
    expect(config).toEqual({
      ok: true,
      value: {
        minTemp: 200,
        maxTemp: 800,
        maxHandling: 1000,
        owner: accounts.shipper,
        active: true,
      },
    });
  });

  it("should reject invalid temperature range", () => {
    const result = monitor.registerShipment(accounts.shipper, 1, 800, 200, 1000);
    expect(result).toEqual({ ok: false, value: 105 });
  });

  it("should detect temperature low violation", () => {
    monitor.registerShipment(accounts.shipper, 1, 200, 800, 1000);
    const submit = monitor.submitSensorData(1, 150, 500); // 1.50°C
    expect(submit).toEqual({ ok: true, value: 0 });

    const violations = monitor.getViolationsByShipment(1);
    expect(violations.value).toHaveLength(1);
    expect(violations.value[0]).toBe(0);

    const v = monitor.getViolation(0);
    expect(v.value).toMatchObject({
      violationType: "temp-low",
      value: 150,
      threshold: 200,
      resolved: false,
    });
  });

  it("should detect multiple violation types in one reading", () => {
    monitor.registerShipment(accounts.shipper, 2, 200, 800, 500);
    monitor.submitSensorData(2, 900, 700); // too hot + too rough

    const vids = monitor.getViolationsByShipment(2).value;
    expect(vids).toHaveLength(2);

    const v1 = monitor.getViolation(vids[0]).value!;
    const v2 = monitor.getViolation(vids[1]).value!;

    expect(new Set([v1.violationType, v2.violationType])).toEqual(
      new Set(["temp-high", "handling"])
    );
  });

  it("should prevent data submission on inactive shipment", () => {
    monitor.registerShipment(accounts.shipper, 3, 200, 800, 1000);
    monitor.deactivateShipment(accounts.shipper, 3);
    const result = monitor.submitSensorData(3, 300, 400);
    expect(result).toEqual({ ok: false, value: 100 });
  });

  it("should resolve a violation", () => {
    monitor.registerShipment(accounts.shipper, 4, 200, 800, 1000);
    monitor.submitSensorData(4, 100, 400);
    const vid = monitor.getViolationsByShipment(4).value[0];

    const resolve = monitor.resolveViolation(vid);
    expect(resolve).toEqual({ ok: true, value: true });

    const v = monitor.getViolation(vid).value!;
    expect(v.resolved).toBe(true);
  });

  it("should return empty violations for clean shipment", () => {
    monitor.registerShipment(accounts.shipper, 5, 200, 800, 1000);
    monitor.submitSensorData(5, 500, 300); // all good
    const vids = monitor.getViolationsByShipment(5);
    expect(vids.value).toHaveLength(0);
  });

  it("should query hasActiveViolations correctly", () => {
    monitor.registerShipment(accounts.shipper, 6, 200, 800, 1000);
    expect(monitor.hasActiveViolations(6)).toEqual({ ok: true, value: false });

    monitor.submitSensorData(6, 100, 400);
    expect(monitor.hasActiveViolations(6)).toEqual({ ok: true, value: true });

    const vid = monitor.getViolationsByShipment(6).value[0];
    monitor.resolveViolation(vid);
    expect(monitor.hasActiveViolations(6)).toEqual({ ok: true, value: false });
  });
});