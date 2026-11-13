# API reference Markdown

API reference documents support headings, lists, links, inline code, fenced code
blocks, and tables. Use level-two headings named **Request example**, **Response
example**, or **Code examples** to place those sections in an examples panel beside
the documentation on wide screens. Plural forms and “Example request” / “Example
response” also work. Each section ends at the next level-one or level-two heading;
level-three headings can label languages inside the example section.

The panel stacks below the documentation on smaller screens. Documents without
these headings retain the usual reading layout and table of contents. These are
static documentation examples; they do not execute requests or collect credentials.

````markdown
Pay-in funds not yet settled to you.

- `totalBalanceMinor`: net pay-ins awaiting settlement.
- **Currency:** all amounts use minor units.

## Query parameters

| Name | Type | Description |
| --- | --- | --- |
| `accountType` | string | Account to read. |

## Request example

### Shell

```bash
curl https://api.example.com/v1/balances/payin
```

## Responses

| Status | Description |
| --- | --- |
| 200 | Success |
| 400 | Bad request |

## Response example

```json
{ "totalBalanceMinor": 12000, "currency": "USD" }
```
````

## Portability contract

Use CommonMark headings, lists, links, inline code and fenced blocks, with GFM
pipe tables. Do not require executable MDX or vendor-specific components for
endpoint content. Example headings are a Breezify presentation enhancement, not
an industry-standard layout directive; other renderers can show them inline.

Keep the API contract as a separate OpenAPI 3.1 JSON/YAML document. Preserve
`operationId`, paths, methods, parameters, schemas, security and response codes.
Store illustrative responses in standard media-type `examples` fields. Keep
vendor navigation and page frontmatter separate from this portable contract.

The Breeze sample is in `docs/examples/breeze/`: a readable Markdown page plus
its endpoint-scoped OpenAPI JSON. Its original export lacked `info`; the sample
adds a title and an explicitly `unversioned` version rather than claiming an
upstream release version. Illustrative response data is labeled accordingly.
The seeded document also retains the OpenAPI object in
`source_metadata.api_reference.spec` for subsequent export tooling.

Platform import references:

- Mintlify: https://mintlify.com/docs/api-playground/overview
- ReadMe: https://docs.readme.com/main/docs/openapi
- Docsalot: https://docs.docsalot.dev/document-apis/openapi-setup
- Fern: https://buildwithfern.com/learn/docs/api-references/generate-api-ref

All four support OpenAPI-backed references, but navigation configuration, MDX
components, and interactive layouts differ. Importing these files into each
platform still requires its own project configuration; identical visual output
and round-trip conversion of vendor components are not guaranteed.
