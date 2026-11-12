GET /v1/balances/payin

Pay-in funds not yet settled to you, and how they split across upcoming settlements.

Reads one pay-in account: `accountType` when given, otherwise your main pay-in account (`payIn` for most merchants, `cryptoPayIn` for merchants set up for crypto pay-ins). It is not a total across accounts.

- `totalBalanceMinor`: net pay-ins not yet settled to you. Negative when refunds or chargebacks exceed unsettled funds. For IC++ pricing, a refund is deducted once it has settled.

- `ready.amountMinor` = amount of the next upcoming settlement; `ready.settlementDate` is when it is expected to be paid.

- `scheduled.amountMinor` = sum of the upcoming settlements after the next one.

- `pending.amountMinor` = `totalBalanceMinor` − `ready.amountMinor` − `scheduled.amountMinor` (funds not yet allocated to a settlement; negative in a deficit).

- `percent` = slice amount ÷ `totalBalanceMinor` × 100; 0 when there is no positive balance.

Amounts are in minor units of `currency`. Balances are cached for up to a minute; `asOf` is when this one was computed.

## Query parameters

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `accountType` | enum: `payIn`, `cryptoPayIn` |  | Pay-in account to read. Defaults to your main pay-in account: `payIn` (fiat) for most merchants, `cryptoPayIn` for merchants set up for crypto pay-ins. Not a total across accounts. |

## Responses

### 200 — Success

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | enum: `SUCCEEDED` | Yes |  |
| `data` | object | Yes | `GET /v1/dashboard/payin-balance` |
| `data.asOf` | number | Yes | When the balance was computed (unix ms); balances are cached for up to a minute. |
| `data.totalBalanceMinor` | number | Yes | Signed: negative when the merchant is in deficit. |
| `data.currency` | enum: `USD`, `EUR` | Yes |  |
| `data.ready` | object | Yes | Amount ready in the next upcoming settlement; `settlementDate` is its expected transfer time (unix ms). |
| `data.ready.settlementDate` | number |  |  |
| `data.ready.amountMinor` | number | Yes |  |
| `data.ready.percent` | number | Yes |  |
| `data.scheduled` | object | Yes | Amount across settlements scheduled after the next one. |
| `data.scheduled.amountMinor` | number | Yes |  |
| `data.scheduled.percent` | number | Yes |  |
| `data.pending` | object | Yes | Balance not yet allocated to a settlement: total − ready − scheduled, so negative in a deficit. |
| `data.pending.amountMinor` | number | Yes |  |
| `data.pending.percent` | number | Yes |  |

### 400 — Bad request

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | enum: `FAILED` | Yes |  |
| `errorCode` | string | Yes |  |
| `errorMessage` | string | Yes |  |

### 401 — Unauthorized

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | enum: `FAILED` | Yes |  |
| `errorCode` | string | Yes |  |
| `errorMessage` | string | Yes |  |

## Authentication

Use HTTP Basic authentication with your API key as the username and an empty password. Required permission: `settlements.read`.

## Request example

### Shell

```bash
curl --request GET \
  --url "https://api.breeze.cash/v1/balances/payin?accountType=payIn" \
  --user "${BREEZE_API_KEY}:" \
  --header "Accept: application/json"
```

## Response example

### 200 — Success

Illustrative values, not a live API response.

```json
{
  "status": "SUCCEEDED",
  "data": {
    "asOf": 1794398400000,
    "totalBalanceMinor": 10000,
    "currency": "USD",
    "ready": {
      "settlementDate": 1794484800000,
      "amountMinor": 5000,
      "percent": 50
    },
    "scheduled": {
      "amountMinor": 3000,
      "percent": 30
    },
    "pending": {
      "amountMinor": 2000,
      "percent": 20
    }
  }
}
```

### 400 — Bad request / 401 — Unauthorized

Error shape; placeholder values.

```json
{
  "status": "FAILED",
  "errorCode": "string",
  "errorMessage": "string"
}
```

