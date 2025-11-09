;; monitor.clar
;; Core violation-detection engine for TempChain
;; Monitors temperature & handling (g-force) in real-time, supports multiple thresholds,
;; logs violations immutably, and emits events for off-chain alerting.

(define-constant ERR-SHIPMENT-NOT-FOUND u100)
(define-constant ERR-INVALID-TEMPERATURE u101)
(define-constant ERR-INVALID-HANDLING u102)
(define-constant ERR-NO-VIOLATIONS u103)
(define-constant ERR-UNAUTHORIZED u104)
(define-constant ERR-INVALID-THRESHOLD u105)

(define-constant MAX-LOGS-PER-SHIPMENT u500)
(define-constant MAX-VIOLATIONS-STORED u100)

;; Shipment configuration (from ShipmentFactory)
(define-map shipment-config
  { shipment-id: uint }
  {
    min-temp: int,           ;; e.g., 2C -> 200 (in centi-degrees)
    max-temp: int,           ;; e.g., 8C -> 800
    max-handling: uint,      ;; max g-force * 100 (e.g., 1000 = 10.00g)
    owner: principal,
    active: bool
  }
)

;; Real-time sensor data log
(define-map sensor-logs
  { shipment-id: uint, index: uint }
  {
    timestamp: uint,
    temperature: int,        ;; centi-degrees
    handling: uint,          ;; g-force * 100
    block-height: uint
  }
)

(define-data-var log-counter uint u0)

;; Violation registry (immutable proof)
(define-map violations
  { violation-id: uint }
  {
    shipment-id: uint,
    log-index: uint,
    violation-type: (string-ascii 16),  ;; "temp-low" | "temp-high" | "handling"
    value: int,
    threshold: int,
    timestamp: uint,
    resolved: bool
  }
)

(define-data-var violation-counter uint u0)

;; Events (for off-chain indexing)
(define-public (emit-violation-event (shipment-id uint) (log-index uint) (v-type (string-ascii 16)) (value int) (threshold int))
  (print {
    event: "violation-detected",
    shipment-id: shipment-id,
    log-index: log-index,
    type: v-type,
    value: value,
    threshold: threshold,
    timestamp: stacks-block-height
  })
  (ok true)
)

;; === ADMIN FUNCTIONS ===
(define-public (register-shipment
    (shipment-id uint)
    (min-temp int)
    (max-temp int)
    (max-handling uint)
  )
  (begin
    (asserts! (>= max-temp min-temp) (err ERR-INVALID-THRESHOLD))
    (asserts! (> max-handling u0) (err ERR-INVALID-THRESHOLD))
    (map-set shipment-config
      { shipment-id: shipment-id }
      {
        min-temp: min-temp,
        max-temp: max-temp,
        max-handling: max-handling,
        owner: tx-sender,
        active: true
      }
    )
    (ok true)
  )
)

(define-public (deactivate-shipment (shipment-id uint))
  (match (map-get? shipment-config { shipment-id: shipment-id })
    config
    (if (is-eq (get owner config) tx-sender)
      (begin
        (map-set shipment-config
          { shipment-id: shipment-id }
          (merge config { active: false })
        )
        (ok true)
      )
      (err ERR-UNAUTHORIZED)
    )
    (err ERR-SHIPMENT-NOT-FOUND)
  )
)

;; === DATA INGESTION (called by Oracle.clar) ===
(define-public (submit-sensor-data
    (shipment-id uint)
    (temperature int)
    (handling uint)
  )
  (let (
    (config (unwrap! (map-get? shipment-config { shipment-id: shipment-id }) (err ERR-SHIPMENT-NOT-FOUND)))
    (current-index (var-get log-counter))
  )
    (asserts! (get active config) (err ERR-SHIPMENT-NOT-FOUND))
    (asserts! (<= current-index MAX-LOGS-PER-SHIPMENT) (err ERR-INVALID-TEMPERATURE))

    ;; Store log
    (map-set sensor-logs
      { shipment-id: shipment-id, index: current-index }
      {
        timestamp: (unwrap! (get-block-info? time u0) u0),
        temperature: temperature,
        handling: handling,
        block-height: stacks-block-height
      }
    )

    ;; Increment global counter
    (var-set log-counter (+ current-index u1))

    ;; Detect violations
    (try! (detect-and-record-violation shipment-id current-index temperature handling config))

    (ok current-index)
  )
)

;; === PRIVATE VIOLATION DETECTION ===
(define-private (detect-and-record-violation
    (shipment-id uint)
    (log-index uint)
    (temperature int)
    (handling uint)
    (config { min-temp: int, max-temp: int, max-handling: uint, owner: principal, active: bool })
  )
  (let (
    (min-temp (get min-temp config))
    (max-temp (get max-temp config))
    (max-handling (get max-handling config))
  )
    (if (< temperature min-temp)
      (try! (record-violation shipment-id log-index "temp-low" temperature min-temp))
      true
    )
    (if (> temperature max-temp)
      (try! (record-violation shipment-id log-index "temp-high" temperature max-temp))
      true
    )
    (if (> handling max-handling)
      (try! (record-violation shipment-id log-index "handling" handling max-handling))
      true
    )
    (ok u0)
  )
)

(define-private (record-violation
    (shipment-id uint)
    (log-index uint)
    (v-type (string-ascii 16))
    (value int)
    (threshold int)
  )
  (let ((vid (var-get violation-counter)))
    (map-set violations
      { violation-id: vid }
      {
        shipment-id: shipment-id,
        log-index: log-index,
        violation-type: v-type,
        value: value,
        threshold: threshold,
        timestamp: stacks-block-height,
        resolved: false
      }
    )
    (var-set violation-counter (+ vid u1))
    (try! (emit-violation-event shipment-id log-index v-type value threshold))
    (ok vid)
  )
)

;; === READ-ONLY QUERIES ===
(define-read-only (get-shipment-config (shipment-id uint))
  (map-get? shipment-config { shipment-id: shipment-id })
)

(define-read-only (get-sensor-log (shipment-id uint) (index uint))
  (map-get? sensor-logs { shipment-id: shipment-id, index: index })
)

(define-read-only (get-violation (violation-id uint))
  (map-get? violations { violation-id: violation-id })
)

(define-read-only (get-violations-by-shipment (shipment-id uint))
  (filter
    (lambda (vid uint)
      (match (map-get? violations { violation-id: vid })
        v (and (is-eq (get shipment-id v) shipment-id) (not (get resolved v)))
        false
      )
    )
    (fold
      (lambda (acc (list 100 uint)) (vid uint) acc)
      (list)
      (range (var-get violation-counter))
    )
  )
)

(define-read-only (has-active-violations (shipment-id uint))
  (match (map-get? shipment-config { shipment-id: shipment-id })
    config
    (and
      (get active config)
      (is-some
        (fold
          (lambda (found bool) (vid uint)
            (or found
              (match (map-get? violations { violation-id: vid })
                v (and (is-eq (get shipment-id v) shipment-id) (not (get resolved v)))
                false
              )
            )
          )
          false
          (range (var-get violation-counter))
        )
      )
    )
    false
  )
)

;; === RESOLUTION (for Claim.clar integration) ===
(define-public (resolve-violation (violation-id uint))
  (match (map-get? violations { violation-id: violation-id })
    v
    (if (not (get resolved v))
      (begin
        (map-set violations
          { violation-id: violation-id }
          (merge v { resolved: true })
        )
        (ok true)
      )
      (err ERR-NO-VIOLATIONS)
    )
    (err ERR-SHIPMENT-NOT-FOUND)
  )
)