;; oracle.clar
;; Core Oracle Contract for TempChain: Secure IoT Data Ingestion
;; Version: 1.0.0
;; Author: TempChain Core Team
;; License: MIT

;; =============================================================================
;; CONSTANTS & ERROR CODES
;; =============================================================================

(define-constant CONTRACT-OWNER tx-sender)
(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-ORACLE-NOT-ACTIVE u101)
(define-constant ERR-INVALID-SHIPMENT-ID u102)
(define-constant ERR-SHIPMENT-CLOSED u103)
(define-constant ERR-INVALID-TEMPERATURE u104)
(define-constant ERR-INVALID-HANDLING u105)
(define-constant ERR-DATA-RATE-LIMIT u106)
(define-constant ERR-INVALID-TIMESTAMP u107)
(define-constant ERR-SHIPMENT-CONTRACT-NOT-SET u108)
(define-constant ERR-ORACLE-ALREADY-REGISTERED u109)
(define-constant ERR-ORACLE-NOT-REGISTERED u110)

(define-constant MIN-TEMPERATURE -500)  ;; -50.0C (in 0.1C units)
(define-constant MAX-TEMPERATURE 1000)  ;; +100.0C
(define-constant MAX-HANDLING u500)     ;; Max 50g acceleration
(define-constant DATA-RATE-LIMIT u6)    ;; Max 1 reading per 10 blocks (~1 min)

;; =============================================================================
;; DATA MAPS
;; =============================================================================

;; Registered and active oracles
(define-map oracles principal { active: bool, registered-at: uint, last-submission: uint })

;; Shipment contract reference (set once by owner)
(define-data-var shipment-contract (optional principal) none)

;; Historical data rate tracking per oracle per shipment
(define-map submission-tracker 
  { oracle: principal, shipment-id: uint } 
  { last-block: uint, count-in-window: uint }
)

;; =============================================================================
;; PRIVATE FUNCTIONS
;; =============================================================================

(define-private (is-valid-temperature (temp int))
  (and (>= temp MIN-TEMPERATURE) (<= temp MAX-TEMPERATURE))
)

(define-private (is-valid-handling (handling uint))
  (<= handling MAX-HANDLING)
)

(define-private (is-shipment-active (shipment-id uint))
  (match (contract-call? .shipment get-shipment shipment-id)
    shipment-info
    (and 
      (is-eq (get status shipment-info) "active")
      (is-some (get creator shipment-info))
    )
    false
  )
)

(define-private (check-rate-limit (oracle principal) (shipment-id uint))
  (let (
    (current-block block-height)
    (key { oracle: oracle, shipment-id: shipment-id })
    (existing (map-get? submission-tracker key))
  )
    (if (is-some existing)
      (let (
        (record (unwrap! existing (err ERR-DATA-RATE-LIMIT)))
        (blocks-since-last (- current-block (get last-block record)))
      )
        (if (>= blocks-since-last u10)
          ;; Reset window
          (begin
            (map-set submission-tracker key { last-block: current-block, count-in-window: u1 })
            (ok true)
          )
          (if (< (get count-in-window record) DATA-RATE-LIMIT)
            (begin
              (map-set submission-tracker key 
                (merge record { count-in-window: (+ (get count-in-window record) u1) })
              )
              (ok true)
            )
            (err ERR-DATA-RATE-LIMIT)
          )
        )
      )
      ;; First submission
      (begin
        (map-set submission-tracker key { last-block: current-block, count-in-window: u1 })
        (ok true)
      )
    )
  )
)

;; =============================================================================
;; PUBLIC FUNCTIONS
;; =============================================================================

;; Register a new oracle (only contract owner)
(define-public (register-oracle (oracle principal))
  (let ((existing (map-get? oracles oracle)))
    (asserts! (is-eq tx-sender CONTRACT-OWNER) (err ERR-NOT-AUTHORIZED))
    (asserts! (is-none existing) (err ERR-ORACLE-ALREADY-REGISTERED))
    (map-set oracles oracle {
      active: true,
      registered-at: block-height,
      last-submission: u0
    })
    (ok true)
  )
)

;; Deactivate oracle (only owner)
(define-public (deactivate-oracle (oracle principal))
  (let ((entry (map-get? oracles oracle)))
    (asserts! (is-eq tx-sender CONTRACT-OWNER) (err ERR-NOT-AUTHORIZED))
    (asserts! (is-some entry) (err ERR-ORACLE-NOT-REGISTERED))
    (map-set oracles oracle (merge (unwrap! entry (err ERR-ORACLE-NOT-REGISTERED)) { active: false }))
    (ok true)
  )
)

;; Set shipment contract (once, by owner)
(define-public (set-shipment-contract (contract principal))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) (err ERR-NOT-AUTHORIZED))
    (asserts! (is-none (var-get shipment-contract)) (err ERR-NOT-AUTHORIZED))
    (var-set shipment-contract (some contract))
    (ok true)
  )
)

;; Submit IoT data - core function
(define-public (submit-data 
  (shipment-id uint) 
  (temperature int) 
  (handling uint) 
  (timestamp uint)
)
  (let (
    (oracle tx-sender)
    (oracle-info (map-get? oracles oracle))
    (shipment-contract-principal (var-get shipment-contract))
  )
    ;; Authorization & state checks
    (asserts! (is-some oracle-info) (err ERR-ORACLE-NOT-ACTIVE))
    (asserts! (get active (unwrap! oracle-info (err ERR-ORACLE-NOT-ACTIVE))) (err ERR-ORACLE-NOT-ACTIVE))
    (asserts! (is-some shipment-contract-principal) (err ERR-SHIPMENT-CONTRACT-NOT-SET))
    (asserts! (is-valid-temperature temperature) (err ERR-INVALID-TEMPERATURE))
    (asserts! (is-valid-handling handling) (err ERR-INVALID-HANDLING))
    (asserts! (> timestamp u0) (err ERR-INVALID-TIMESTAMP))
    (asserts! (is-shipment-active shipment-id) (err ERR-SHIPMENT-CLOSED))

    ;; Rate limiting
    (try! (check-rate-limit oracle shipment-id))

    ;; Forward to shipment contract
    (try! (contract-call? (unwrap! shipment-contract-principal (err ERR-SHIPMENT-CONTRACT-NOT-SET))
            log-data shipment-id temperature handling))

    ;; Update oracle last submission
    (map-set oracles oracle 
      (merge (unwrap! oracle-info (err ERR-ORACLE-NOT-ACTIVE)) 
        { last-submission: block-height }))

    (ok {
      shipment-id: shipment-id,
      temperature: temperature,
      handling: handling,
      timestamp: timestamp,
      block: block-height
    })
  )
)

;; Emergency pause for oracle (owner only)
(define-public (pause-oracle (oracle principal))
  (let ((entry (map-get? oracles oracle)))
    (asserts! (is-eq tx-sender CONTRACT-OWNER) (err ERR-NOT-AUTHORIZED))
    (asserts! (is-some entry) (err ERR-ORACLE-NOT-REGISTERED))
    (map-set oracles oracle (merge (unwrap! entry (err ERR-ORACLE-NOT-REGISTERED)) { active: false }))
    (ok true)
  )
)

;; =============================================================================
;; READ-ONLY FUNCTIONS
;; =============================================================================

(define-read-only (get-oracle-info (oracle principal))
  (map-get? oracles oracle)
)

(define-read-only (is-oracle-active (oracle principal))
  (match (map-get? oracles oracle)
    info (get active info)
    false
  )
)

(define-read-only (get-shipment-contract)
  (var-get shipment-contract)
)

(define-read-only (get-submission-count (oracle principal) (shipment-id uint))
  (match (map-get? submission-tracker { oracle: oracle, shipment-id: shipment-id })
    record (get count-in-window record)
    u0
  )
)

(define-read-only (can-submit-now (oracle principal) (shipment-id uint))
  (let (
    (current-block block-height)
    (key { oracle: oracle, shipment-id: shipment-id })
    (existing (map-get? submission-tracker key))
  )
    (if (is-some existing)
      (let ((record (unwrap! existing false)))
        (or 
          (>= (- current-block (get last-block record)) u10)
          (< (get count-in-window record) DATA-RATE-LIMIT)
        )
      )
      true
    )
  )
)