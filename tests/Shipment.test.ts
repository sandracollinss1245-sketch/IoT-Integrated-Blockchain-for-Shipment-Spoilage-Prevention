import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface ShipmentParams {
  "min-temp": number;
  "max-temp": number;
  "max-handling": number;
  "expected-duration": number;
}

interface Shipment {
  creator: string;
  status: string;
  params: ShipmentParams;
  "start-time": number;
  "end-time": number | null;
  participants: string[];
  "escrow-amount": number;
}

interface LogEntry {
  timestamp: number;
  temp: number;
  handling: number;
  reporter: string;
}

interface ViolationEntry {
  timestamp: number;
  type: string;
  details: string;
}

interface NoteEntry {
  timestamp: number;
  note: string;
  author: string;
}

interface ContractState {
  shipments: Map<number, Shipment>;
  shipmentLogs: Map<number, LogEntry[]>;
  shipmentViolations: Map<number, ViolationEntry[]>;
  shipmentNotes: Map<number, NoteEntry[]>;
  shipmentCounter: number;
}

// Mock contract implementation
class ShipmentMock {
  private state: ContractState = {
    shipments: new Map(),
    shipmentLogs: new Map(),
    shipmentViolations: new Map(),
    shipmentNotes: new Map(),
    shipmentCounter: 0,
  };

  private ERR_INVALID_PARAMS = 102;
  private ERR_NOT_AUTHORIZED = 103;
  private ERR_SHIPMENT_NOT_FOUND = 104;
  private ERR_MAX_LOGS_REACHED = 107;
  private ERR_VIOLATION_DETECTED = 109;
  private MAX_LOG_ENTRIES = 500;
  private MAX_PARTICIPANTS = 10;

  createShipment(
    caller: string,
    minTemp: number,
    maxTemp: number,
    maxHandling: number,
    expectedDuration: number,
    participants: string[],
    escrowAmount: number
  ): ClarityResponse<number> {
    if (minTemp >= maxTemp || maxHandling <= 0 || expectedDuration <= 0) {
      return { ok: false, value: this.ERR_INVALID_PARAMS };
    }
    const shipmentId = this.state.shipmentCounter + 1;
    this.state.shipments.set(shipmentId, {
      creator: caller,
      status: "pending",
      params: { "min-temp": minTemp, "max-temp": maxTemp, "max-handling": maxHandling, "expected-duration": expectedDuration },
      "start-time": 0, // Mock block-height
      "end-time": null,
      participants,
      "escrow-amount": escrowAmount,
    });
    this.state.shipmentCounter = shipmentId;
    return { ok: true, value: shipmentId };
  }

  startShipment(caller: string, shipmentId: number): ClarityResponse<boolean> {
    const shipment = this.state.shipments.get(shipmentId);
    if (!shipment) {
      return { ok: false, value: this.ERR_SHIPMENT_NOT_FOUND };
    }
    if (shipment.status !== "pending" || shipment.creator !== caller) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.shipments.set(shipmentId, { ...shipment, status: "active", "start-time": 100 });
    return { ok: true, value: true };
  }

  logData(caller: string, shipmentId: number, temp: number, handling: number): ClarityResponse<boolean> {
    const shipment = this.state.shipments.get(shipmentId);
    if (!shipment) {
      return { ok: false, value: this.ERR_SHIPMENT_NOT_FOUND };
    }
    if (shipment.status !== "active" || (shipment.creator !== caller && !shipment.participants.includes(caller))) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    const logs = this.state.shipmentLogs.get(shipmentId) ?? [];
    if (logs.length >= this.MAX_LOG_ENTRIES) {
      return { ok: false, value: this.ERR_MAX_LOGS_REACHED };
    }
    const params = shipment.params;
    const violation = this.detectViolation(temp, handling, params);
    if (violation) {
      const violations = this.state.shipmentViolations.get(shipmentId) ?? [];
      violations.push({ timestamp: 100, type: violation, details: "Automated detection" });
      this.state.shipmentViolations.set(shipmentId, violations);
      return { ok: false, value: this.ERR_VIOLATION_DETECTED };
    }
    logs.push({ timestamp: 100, temp, handling, reporter: caller });
    this.state.shipmentLogs.set(shipmentId, logs);
    return { ok: true, value: true };
  }

  private detectViolation(temp: number, handling: number, params: ShipmentParams): string | null {
    if (temp < params["min-temp"]) return "temp-low";
    if (temp > params["max-temp"]) return "temp-high";
    if (handling > params["max-handling"]) return "handling-exceeded";
    return null;
  }

  addNote(caller: string, shipmentId: number, note: string): ClarityResponse<boolean> {
    const shipment = this.state.shipments.get(shipmentId);
    if (!shipment) {
      return { ok: false, value: this.ERR_SHIPMENT_NOT_FOUND };
    }
    if (shipment.creator !== caller && !shipment.participants.includes(caller)) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    const notes = this.state.shipmentNotes.get(shipmentId) ?? [];
    notes.push({ timestamp: 100, note, author: caller });
    this.state.shipmentNotes.set(shipmentId, notes);
    return { ok: true, value: true };
  }

  updateStatus(caller: string, shipmentId: number, newStatus: string): ClarityResponse<boolean> {
    const shipment = this.state.shipments.get(shipmentId);
    if (!shipment) {
      return { ok: false, value: this.ERR_SHIPMENT_NOT_FOUND };
    }
    if (shipment.creator !== caller) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.shipments.set(shipmentId, { ...shipment, status: newStatus });
    return { ok: true, value: true };
  }

  closeShipment(caller: string, shipmentId: number): ClarityResponse<boolean> {
    const shipment = this.state.shipments.get(shipmentId);
    if (!shipment) {
      return { ok: false, value: this.ERR_SHIPMENT_NOT_FOUND };
    }
    if (shipment.status === "closed" || shipment.creator !== caller) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.shipments.set(shipmentId, { ...shipment, status: "closed", "end-time": 200 });
    return { ok: true, value: true };
  }

  addParticipant(caller: string, shipmentId: number, newParticipant: string): ClarityResponse<boolean> {
    const shipment = this.state.shipments.get(shipmentId);
    if (!shipment) {
      return { ok: false, value: this.ERR_SHIPMENT_NOT_FOUND };
    }
    if (shipment.creator !== caller) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (shipment.participants.length >= this.MAX_PARTICIPANTS) {
      return { ok: false, value: this.ERR_INVALID_PARAMS };
    }
    const updatedParticipants = [...shipment.participants, newParticipant];
    this.state.shipments.set(shipmentId, { ...shipment, participants: updatedParticipants });
    return { ok: true, value: true };
  }

  getShipmentDetails(shipmentId: number): ClarityResponse<Shipment | null> {
    return { ok: true, value: this.state.shipments.get(shipmentId) ?? null };
  }

  getLogs(shipmentId: number): ClarityResponse<LogEntry[] | null> {
    return { ok: true, value: this.state.shipmentLogs.get(shipmentId) ?? null };
  }

  getViolations(shipmentId: number): ClarityResponse<ViolationEntry[] | null> {
    return { ok: true, value: this.state.shipmentViolations.get(shipmentId) ?? null };
  }

  getNotes(shipmentId: number): ClarityResponse<NoteEntry[] | null> {
    return { ok: true, value: this.state.shipmentNotes.get(shipmentId) ?? null };
  }

  hasViolations(shipmentId: number): ClarityResponse<boolean> {
    const violations = this.state.shipmentViolations.get(shipmentId) ?? [];
    return { ok: true, value: violations.length > 0 };
  }
}

// Test setup
const accounts = {
  creator: "creator",
  participant1: "participant1",
  participant2: "participant2",
  unauthorized: "unauthorized",
};

describe("Shipment Contract", () => {
  let contract: ShipmentMock;

  beforeEach(() => {
    contract = new ShipmentMock();
    vi.resetAllMocks();
  });

  it("should create a new shipment with valid parameters", () => {
    const result = contract.createShipment(
      accounts.creator,
      2,
      8,
      10,
      100,
      [accounts.participant1],
      500
    );
    expect(result).toEqual({ ok: true, value: 1 });
    const details = contract.getShipmentDetails(1);
    expect(details.ok).toBe(true);
    expect(details.value).toBeDefined();
    expect(typeof details.value !== "number").toBe(true);
    if (typeof details.value !== "number" && details.value !== null) {
      expect(details.value.creator).toBe(accounts.creator);
      expect(details.value.status).toBe("pending");
    }
  });

  it("should reject shipment creation with invalid parameters", () => {
    const result = contract.createShipment(
      accounts.creator,
      10,
      5,
      10,
      100,
      [],
      0
    );
    expect(result).toEqual({ ok: false, value: 102 });
  });

  it("should start a pending shipment", () => {
    contract.createShipment(accounts.creator, 2, 8, 10, 100, [], 0);
    const startResult = contract.startShipment(accounts.creator, 1);
    expect(startResult).toEqual({ ok: true, value: true });
    const details = contract.getShipmentDetails(1);
    expect(details.value).toBeDefined();
    expect(typeof details.value !== "number").toBe(true);
    if (typeof details.value !== "number" && details.value !== null) {
      expect(details.value.status).toBe("active");
    }
  });

  it("should prevent unauthorized user from starting shipment", () => {
    contract.createShipment(accounts.creator, 2, 8, 10, 100, [], 0);
    const startResult = contract.startShipment(accounts.unauthorized, 1);
    expect(startResult).toEqual({ ok: false, value: 103 });
  });

  it("should log data for active shipment", () => {
    contract.createShipment(accounts.creator, 2, 8, 10, 100, [accounts.participant1], 0);
    contract.startShipment(accounts.creator, 1);
    const logResult = contract.logData(accounts.participant1, 1, 5, 5);
    expect(logResult).toEqual({ ok: true, value: true });
    const logs = contract.getLogs(1);
    expect(logs.value).toBeDefined();
    expect(typeof logs.value !== "number").toBe(true);
    if (typeof logs.value !== "number" && logs.value !== null) {
      expect(logs.value.length).toBe(1);
      expect(logs.value[0].temp).toBe(5);
    }
  });

  it("should detect and record violation on invalid data", () => {
    contract.createShipment(accounts.creator, 2, 8, 10, 100, [], 0);
    contract.startShipment(accounts.creator, 1);
    const logResult = contract.logData(accounts.creator, 1, 10, 5);
    expect(logResult).toEqual({ ok: false, value: 109 });
    const violations = contract.getViolations(1);
    expect(violations.value).toBeDefined();
    expect(typeof violations.value !== "number").toBe(true);
    if (typeof violations.value !== "number" && violations.value !== null) {
      expect(violations.value.length).toBe(1);
      expect(violations.value[0].type).toBe("temp-high");
    }
  });

  it("should add note to shipment", () => {
    contract.createShipment(accounts.creator, 2, 8, 10, 100, [], 0);
    const noteResult = contract.addNote(accounts.creator, 1, "Test note");
    expect(noteResult).toEqual({ ok: true, value: true });
    const notes = contract.getNotes(1);
    expect(notes.value).toBeDefined();
    expect(typeof notes.value !== "number").toBe(true);
    if (typeof notes.value !== "number" && notes.value !== null) {
      expect(notes.value.length).toBe(1);
      expect(notes.value[0].note).toBe("Test note");
    }
  });

  it("should update shipment status", () => {
    contract.createShipment(accounts.creator, 2, 8, 10, 100, [], 0);
    const updateResult = contract.updateStatus(accounts.creator, 1, "in-transit");
    expect(updateResult).toEqual({ ok: true, value: true });
    const details = contract.getShipmentDetails(1);
    expect(details.value).toBeDefined();
    expect(typeof details.value !== "number").toBe(true);
    if (typeof details.value !== "number" && details.value !== null) {
      expect(details.value.status).toBe("in-transit");
    }
  });

  it("should close shipment", () => {
    contract.createShipment(accounts.creator, 2, 8, 10, 100, [], 0);
    contract.startShipment(accounts.creator, 1);
    const closeResult = contract.closeShipment(accounts.creator, 1);
    expect(closeResult).toEqual({ ok: true, value: true });
    const details = contract.getShipmentDetails(1);
    expect(details.value).toBeDefined();
    expect(typeof details.value !== "number").toBe(true);
    if (typeof details.value !== "number" && details.value !== null) {
      expect(details.value.status).toBe("closed");
    }
  });

  it("should add participant to shipment", () => {
    contract.createShipment(accounts.creator, 2, 8, 10, 100, [], 0);
    const addResult = contract.addParticipant(accounts.creator, 1, accounts.participant1);
    expect(addResult).toEqual({ ok: true, value: true });
    const details = contract.getShipmentDetails(1);
    expect(details.value).toBeDefined();
    expect(typeof details.value !== "number").toBe(true);
    if (typeof details.value !== "number" && details.value !== null) {
      expect(details.value.participants).toContain(accounts.participant1);
    }
  });

  it("should prevent adding participant beyond max", () => {
    contract.createShipment(accounts.creator, 2, 8, 10, 100, Array(10).fill("participant"), 0);
    const addResult = contract.addParticipant(accounts.creator, 1, "extra");
    expect(addResult).toEqual({ ok: false, value: 102 });
  });

  it("should check if shipment has violations", () => {
    contract.createShipment(accounts.creator, 2, 8, 10, 100, [], 0);
    contract.startShipment(accounts.creator, 1);
    contract.logData(accounts.creator, 1, 10, 5); // Violation
    const hasViolations = contract.hasViolations(1);
    expect(hasViolations).toEqual({ ok: true, value: true });
  });
});