import { describe, expect, it, beforeEach, vi } from "vitest";

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

interface OracleInfo {
  active: boolean;
  registeredAt: number;
  lastSubmission: number;
}

interface SubmissionResponse {
  shipmentId: number;
  temperature: number;
  handling: number;
  timestamp: number;
  block: number;
}

interface ClarityOk<T> {
  ok: true;
  value: T;
}

interface ClarityErr {
  ok: false;
  value: number; // error code
}

type ClarityResult<T> = ClarityOk<T> | ClarityErr;

// =============================================================================
// MOCK STATE
// =============================================================================

interface ContractState {
  oracles: Map<string, OracleInfo>;
  shipmentContract: string | null;
  submissionTracker: Map<string, { lastBlock: number; countInWindow: number }>;
  owner: string;
  currentBlock: number;
}

class OracleContractMock {
  private state: ContractState = {
    oracles: new Map(),
    shipmentContract: null,
    submissionTracker: new Map(),
    owner: "deployer",
    currentBlock: 1000,
  };

  // Error codes
  private ERR_NOT_AUTHORIZED = 100;
  private ERR_ORACLE_NOT_ACTIVE = 101;
  private ERR_INVALID_SHIPMENT_ID = 102;
  private ERR_SHIPMENT_CLOSED = 103;
  private ERR_INVALID_TEMPERATURE = 104;
  private ERR_INVALID_HANDLING = 105;
  private ERR_DATA_RATE_LIMIT = 106;
  private ERR_INVALID_TIMESTAMP = 107;
  private ERR_SHIPMENT_CONTRACT_NOT_SET = 108;
  private ERR_ORACLE_ALREADY_REGISTERED = 109;
  private ERR_ORACLE_NOT_REGISTERED = 110;

  // Constants
  private MIN_TEMP = -500;
  private MAX_TEMP = 1000;
  private MAX_HANDLING = 500;
  private RATE_LIMIT = 6;
  private BLOCK_WINDOW = 10;

  // Mock block height control
  advanceBlocks(blocks: number) {
    this.state.currentBlock += blocks;
  }

  get blockHeight() {
    return this.state.currentBlock;
  }

  // =============================================================================
  // MOCK IMPLEMENTATIONS
  // =============================================================================

  registerOracle(caller: string, oracle: string): ClarityResult<boolean> {
    if (caller !== this.state.owner) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    if (this.state.oracles.has(oracle)) return { ok: false, value: this.ERR_ORACLE_ALREADY_REGISTERED };

    this.state.oracles.set(oracle, {
      active: true,
      registeredAt: this.state.currentBlock,
      lastSubmission: 0,
    });
    return { ok: true, value: true };
  }

  deactivateOracle(caller: string, oracle: string): ClarityResult<boolean> {
    if (caller !== this.state.owner) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    const info = this.state.oracles.get(oracle);
    if (!info) return { ok: false, value: this.ERR_ORACLE_NOT_REGISTERED };

    this.state.oracles.set(oracle, { ...info, active: false });
    return { ok: true, value: true };
  }

  setShipmentContract(caller: string, contract: string): ClarityResult<boolean> {
    if (caller !== this.state.owner) return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    if (this.state.shipmentContract !== null) return { ok: false, value: this.ERR_NOT_AUTHORIZED };

    this.state.shipmentContract = contract;
    return { ok: true, value: true };
  }

  submitData(
    caller: string,
    shipmentId: number,
    temperature: number,
    handling: number,
    timestamp: number
  ): ClarityResult<SubmissionResponse> {
    const oracleInfo = this.state.oracles.get(caller);
    if (!oracleInfo || !oracleInfo.active) return { ok: false, value: this.ERR_ORACLE_NOT_ACTIVE };
    if (!this.state.shipmentContract) return { ok: false, value: this.ERR_SHIPMENT_CONTRACT_NOT_SET };
    if (temperature < this.MIN_TEMP || temperature > this.MAX_TEMP)
      return { ok: false, value: this.ERR_INVALID_TEMPERATURE };
    if (handling > this.MAX_HANDLING) return { ok: false, value: this.ERR_INVALID_HANDLING };
    if (timestamp <= 0) return { ok: false, value: this.ERR_INVALID_TIMESTAMP };

    // Mock shipment contract check
    if (shipmentId !== 1) return { ok: false, value: this.ERR_SHIPMENT_CLOSED };

    // Rate limiting
    const key = `${caller}-${shipmentId}`;
    const tracker = this.state.submissionTracker.get(key);
    if (tracker) {
      const blocksSince = this.state.currentBlock - tracker.lastBlock;
      if (blocksSince < this.BLOCK_WINDOW) {
        if (tracker.countInWindow >= this.RATE_LIMIT)
          return { ok: false, value: this.ERR_DATA_RATE_LIMIT };
        this.state.submissionTracker.set(key, {
          lastBlock: tracker.lastBlock,
          countInWindow: tracker.countInWindow + 1,
        });
      } else {
        this.state.submissionTracker.set(key, { lastBlock: this.state.currentBlock, countInWindow: 1 });
      }
    } else {
      this.state.submissionTracker.set(key, { lastBlock: this.state.currentBlock, countInWindow: 1 });
    }

    // Update oracle
    this.state.oracles.set(caller, {
      ...oracleInfo,
      lastSubmission: this.state.currentBlock,
    });

    return {
      ok: true,
      value: {
        shipmentId,
        temperature,
        handling,
        timestamp,
        block: this.state.currentBlock,
      },
    };
  }

  getOracleInfo(oracle: string): ClarityResult<OracleInfo | null> {
    const info = this.state.oracles.get(oracle);
    return { ok: true, value: info ?? null };
  }

  isOracleActive(oracle: string): ClarityResult<boolean> {
    const info = this.state.oracles.get(oracle);
    return { ok: true, value: info?.active ?? false };
  }

  getShipmentContract(): ClarityResult<string | null> {
    return { ok: true, value: this.state.shipmentContract };
  }

  canSubmitNow(oracle: string, shipmentId: number): ClarityResult<boolean> {
    const key = `${oracle}-${shipmentId}`;
    const tracker = this.state.submissionTracker.get(key);
    if (!tracker) return { ok: true, value: true };

    const blocksSince = this.state.currentBlock - tracker.lastBlock;
    return {
      ok: true,
      value: blocksSince >= this.BLOCK_WINDOW || tracker.countInWindow < this.RATE_LIMIT,
    };
  }
}

// =============================================================================
// TEST SUITE
// =============================================================================

const accounts = {
  deployer: "deployer",
  oracle1: "oracle_1",
  oracle2: "oracle_2",
  malicious: "attacker",
  shipmentContract: "SP000.shiment",
};

describe("Oracle Contract - Core IoT Data Ingestion", () => {
  let contract: OracleContractMock;

  beforeEach(() => {
    contract = new OracleContractMock();
    vi.resetAllMocks();
  });

  describe("Oracle Registration & Management", () => {
    it("should allow owner to register oracle", () => {
      const result = contract.registerOracle(accounts.deployer, accounts.oracle1);
      expect(result).toEqual({ ok: true, value: true });

      const info = contract.getOracleInfo(accounts.oracle1);
      expect(info).toEqual({
        ok: true,
        value: expect.objectContaining({
          active: true,
          registeredAt: 1000,
        }),
      });
    });

    it("should prevent non-owner from registering oracle", () => {
      const result = contract.registerOracle(accounts.malicious, accounts.oracle1);
      expect(result).toEqual({ ok: false, value: 100 });
    });

    it("should prevent duplicate oracle registration", () => {
      contract.registerOracle(accounts.deployer, accounts.oracle1);
      const result = contract.registerOracle(accounts.deployer, accounts.oracle1);
      expect(result).toEqual({ ok: false, value: 109 });
    });

    it("should allow owner to deactivate oracle", () => {
      contract.registerOracle(accounts.deployer, accounts.oracle1);
      const result = contract.deactivateOracle(accounts.deployer, accounts.oracle1);
      expect(result).toEqual({ ok: true, value: true });

      const active = contract.isOracleActive(accounts.oracle1);
      expect(active).toEqual({ ok: true, value: false });
    });
  });

  describe("Shipment Contract Integration", () => {
    it("should allow owner to set shipment contract once", () => {
      const result = contract.setShipmentContract(accounts.deployer, accounts.shipmentContract);
      expect(result).toEqual({ ok: true, value: true });

      const stored = contract.getShipmentContract();
      expect(stored).toEqual({ ok: true, value: accounts.shipmentContract });
    });

    it("should prevent setting shipment contract twice", () => {
      contract.setShipmentContract(accounts.deployer, accounts.shipmentContract);
      const result = contract.setShipmentContract(accounts.deployer, "another");
      expect(result).toEqual({ ok: false, value: 100 });
    });
  });

  describe("Data Submission - Success Path", () => {
    beforeEach(() => {
      contract.registerOracle(accounts.deployer, accounts.oracle1);
      contract.setShipmentContract(accounts.deployer, accounts.shipmentContract);
    });

    it("should allow active oracle to submit valid data", () => {
      const result = contract.submitData(
        accounts.oracle1,
        1,
        50, // 5.0°C
        15,
        Date.now()
      );

      expect(result).toEqual({
        ok: true,
        value: expect.objectContaining({
          shipmentId: 1,
          temperature: 50,
          handling: 15,
          block: 1000,
        }),
      });
    });

    it("should update oracle's last submission", () => {
      contract.submitData(accounts.oracle1, 1, 50, 10, Date.now());
      const info = contract.getOracleInfo(accounts.oracle1);
      expect(info.value?.lastSubmission).toBe(1000);
    });
  });

  describe("Data Validation", () => {
    beforeEach(() => {
      contract.registerOracle(accounts.deployer, accounts.oracle1);
      contract.setShipmentContract(accounts.deployer, accounts.shipmentContract);
    });

    it("should reject temperature below range", () => {
      const result = contract.submitData(accounts.oracle1, 1, -600, 10, Date.now());
      expect(result).toEqual({ ok: false, value: 104 });
    });

    it("should reject temperature above range", () => {
      const result = contract.submitData(accounts.oracle1, 1, 1500, 10, Date.now());
      expect(result).toEqual({ ok: false, value: 104 });
    });

    it("should reject handling above limit", () => {
      const result = contract.submitData(accounts.oracle1, 1, 50, 600, Date.now());
      expect(result).toEqual({ ok: false, value: 105 });
    });

    it("should reject invalid timestamp", () => {
      const result = contract.submitData(accounts.oracle1, 1, 50, 10, 0);
      expect(result).toEqual({ ok: false, value: 107 });
    });
  });

  describe("Rate Limiting", () => {
    beforeEach(() => {
      contract.registerOracle(accounts.deployer, accounts.oracle1);
      contract.setShipmentContract(accounts.deployer, accounts.shipmentContract);
    });

    it("should allow up to 6 submissions in 10-block window", () => {
      for (let i = 0; i < 6; i++) {
        const result = contract.submitData(accounts.oracle1, 1, 50, 10, Date.now());
        expect(result.ok).toBe(true);
      }

      const seventh = contract.submitData(accounts.oracle1, 1, 50, 10, Date.now());
      expect(seventh).toEqual({ ok: false, value: 106 });
    });

    it("should reset rate limit after 10 blocks", () => {
      // Submit 6
      for (let i = 0; i < 6; i++) {
        contract.submitData(accounts.oracle1, 1, 50, 10, Date.now());
      }

      // Advance 10 blocks
      contract.advanceBlocks(10);

      // Should allow again
      const result = contract.submitData(accounts.oracle1, 1, 50, 10, Date.now());
      expect(result.ok).toBe(true);
    });

    it("can-submit-now should predict correctly", () => {
      contract.submitData(accounts.oracle1, 1, 50, 10, Date.now());
      const canSubmit = contract.canSubmitNow(accounts.oracle1, 1);
      expect(canSubmit).toEqual({ ok: true, value: true }); // still under limit
    });
  });

  describe("Security & Access Control", () => {
    it("should reject inactive oracle", () => {
      contract.registerOracle(accounts.deployer, accounts.oracle1);
      contract.deactivateOracle(accounts.deployer, accounts.oracle1);
      contract.setShipmentContract(accounts.deployer, accounts.shipmentContract);

      const result = contract.submitData(accounts.oracle1, 1, 50, 10, Date.now());
      expect(result).toEqual({ ok: false, value: 101 });
    });

    it("should reject unregistered caller", () => {
      contract.setShipmentContract(accounts.deployer, accounts.shipmentContract);
      const result = contract.submitData(accounts.malicious, 1, 50, 10, Date.now());
      expect(result).toEqual({ ok: false, value: 101 });
    });
  });
});