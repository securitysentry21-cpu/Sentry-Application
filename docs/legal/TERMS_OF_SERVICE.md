# Terms of Service

> **DRAFT for lawyer review. Not legal advice. Date: 2026-11-08.**
> Prepared by an AI coding assistant from the code and the specifications, not by a lawyer. It is not final and must not be published as it is. Open points are marked `[OWNER TO CONFIRM: ...]` and `[LAWYER: ...]`.

**Service:** `[APP NAME]` (working name: SENTRY): the guard app, the web dashboard and the API (the **"Service"**).
**Provider:** `[COMPANY LEGAL NAME]`, `[COMPANY ADDRESS]`, registration number `[REGISTRATION NUMBER]` ("we").
**Customer:** the private security company that has an organization in the Service.
**Last updated:** `[DATE]`

## 1. Who these terms are for

1.1 These terms are an agreement between us and the Customer. The Customer's staff use the Service under the Customer's authority.
1.2 **Dashboard users** (owners, administrators, supervisors, dispatchers, duty officers) are invited by the Customer. When someone accepts an invitation, they agree to section 6 (acceptable use) on their own behalf.
1.3 **Guards** get the app from the Customer. A guard cannot join an organization alone. A guard uses the app only to do the Customer's work. The guard's relationship with the Customer is the Customer's responsibility. Source: `docs/PRODUCT_SPEC.md` §4.2.
1.4 `[LAWYER: whether guards need to accept short end-user terms inside the app, or whether the in-app tracking notice and the Customer's own policy are enough. Today the app has only the tracking notice.]`

## 2. What the Service does

2.1 The Service lets a security company manage guards, client sites, shifts and patrol checkpoints; track guards' phones during active shifts; detect exceptions such as a guard leaving a site or missing a patrol; receive alerts; record incidents with photos; and make attendance and patrol reports. Source: `docs/PRODUCT_SPEC.md` §1.1.
2.2 We provide it "as it is built" at the time of use. Features may be off for some customers. In particular, **the SOS feature is switched off for pilot guards** until its tests pass on real phones and the owner approves. `[OWNER TO CONFIRM: update when SOS is switched on]` Source: `docs/DECISIONS.md` D-34; `infra/terraform/cell/services.tf` (`FEATURE_SOS=false`).
2.3 Organizations are created by us. There is no self-sign-up for organizations. Source: `docs/PRODUCT_SPEC.md` §2.3 A-07.

## 3. Accounts and access

3.1 Dashboard users sign in with an email address, a password and an authenticator-app code. Everyone must use the authenticator code. Source: `infra/terraform/cell/auth.tf`.
3.2 The Customer is responsible for who it invites and which role each person gets, and for removing people who leave. Keep sign-ins personal. Do not share them.
3.3 Guards are enrolled with a single-use code that the Customer's supervisor gives them. Codes expire after 7 days. Source: `docs/SECURITY_AND_INVARIANTS.md` §5.
3.4 We may suspend an organization (for example for non-payment, abuse or legal reasons). Suspending an organization stops its dashboard users. **SOS events from its guards are still accepted and stored.** Source: `docs/SECURITY_AND_INVARIANTS.md` §4.3, INV-15. `[LAWYER: grounds, notice, cure period]`

## 4. The Customer's responsibilities

The Customer must:

1. have a lawful basis to monitor its guards, and follow the labour, privacy and employee-monitoring rules that apply to it `[LAWYER: list]`;
2. tell its guards clearly what is tracked, when, why, who sees it and how long it is kept, before tracking starts. The app shows a tracking notice before any permission request, but the Customer remains responsible for what it tells its staff;
3. use tracking only for guards on assigned shifts, and not to follow anyone secretly or anyone who is not its employee or contractor;
4. keep guard records, phone numbers and site details correct;
5. **staff its control room** if it relies on SOS and alerts. The Service shows a banner when guards are on shift and nobody has the dashboard open (monitoring coverage), but it cannot make a person look at a screen. Source: `docs/PRODUCT_SPEC.md` §11.5;
6. decide for itself how to respond to alerts, SOS, incidents and location data, and for what it does with the reports it gives its own clients;
7. sign the Data Processing Agreement (`DATA_PROCESSING_AGREEMENT.md`).

## 5. Important limits: please read

5.1 **SOS is not an emergency service.** SOS alerts the Customer's own control room and duty officers. It does not call the police, an ambulance, the fire service or any emergency service. The Customer and guards must not rely on it as a replacement for calling emergency services. The app says the same. Source: `apps/mobile/src/core/i18n/en.ts` (`sos.disclaimer`); `docs/PRODUCT_SPEC.md` §11.1.
5.2 **Delivery and response are not guaranteed.** Alerts and texts can fail or be late: the phone may have no signal, battery or permission; a notification provider may be down; silent mode and Do Not Disturb can hide notifications; nobody may be watching. The Service shows the real state ("received", "alert sent", "notified", "acknowledged") and never claims one it has not confirmed. We do not promise delivery times, response times or availability in these terms. `[OWNER TO CONFIRM: whether to offer a service level. The internal targets in docs/ARCHITECTURE.md §18.3 (for example 99.9% monthly availability for sync and SOS routes) are engineering targets, not promises. Do not copy them here unless the owner decides to commit.]`
5.3 **Location is evidence, not proof.** The Service shows device location evidence. It does not prove that a person stood at a place, and it can be wrong or be tricked. It shows accuracy and age, and flags suspicious signs. It does not promise any accuracy. Source: `docs/PRODUCT_SPEC.md` §1.3, §8.5.
5.4 **Tracking depends on the phone.** Phone makers, battery savers, permissions and updates can stop tracking. The Service reports gaps; it cannot prevent them. We test on a list of phones but cannot promise that tracking works on every phone. Source: `docs/ARCHITECTURE.md` §20.2.
5.5 **Not for other uses.** The Service is not an emergency-response system, medical device, payroll, or a way to monitor people secretly.

## 6. Acceptable use

Do not: access another organization's data; try to bypass the security of the Service; scrape or copy data in bulk outside the export functions; send malware or harmful files; fake locations on purpose to mislead the Customer's records; use the Service to harass, stalk or illegally monitor anyone; use the Service in ways the law forbids; resell it. `[LAWYER: complete]`

## 7. Data and privacy

7.1 **The Customer's data stays the Customer's.** We process it only to provide the Service, as set out in the Data Processing Agreement and the Privacy Policy (`PRIVACY_POLICY.md`).
7.2 **We do not sell personal data, and we do not use location data for advertising.** Source: `docs/PRODUCT_SPEC.md` §2.2.
7.3 **Retention.** Data is kept for the periods in the Privacy Policy and the DPA. These are defaults.
7.4 **After the agreement ends,** see the DPA, section 11.

## 8. Fees

`[OWNER TO CONFIRM: prices, billing period, payment terms, taxes, trial or pilot terms]`. Billing and invoicing are not part of the product in the first version (`docs/PRODUCT_SPEC.md` §2.2), so fees are handled outside the Service.
`[OWNER TO CONFIRM: whether the pilot customer signs a separate pilot agreement.]`

## 9. Intellectual property

9.1 We own the Service, its software and its brand. The Customer gets a limited right to use it during the agreement. `[LAWYER]`
9.2 The Customer owns its data. We may use scrubbed technical information (for example error reports and performance numbers that contain no personal data) to run and improve the Service.
9.3 Maps use OpenStreetMap data through OpenFreeMap and are credited on the map `[OWNER TO CONFIRM: attribution text and licence terms are shown on the dashboard map]`. The Service includes open-source software under its own licences, which a licence check reviews in CI.
9.4 **Brand.** The name SENTRY is a working name and the logo was generated with an AI image tool. Trademark and copyright status are being reviewed. `[LAWYER: trademark search for the final name; ownership and protection of the AI-generated logo]` Source: `docs/DECISIONS.md` (Brand).

## 10. Availability and changes

10.1 We may update the Service. When a new app version is needed for security or compatibility, older versions may be blocked from starting shifts. SOS is never blocked by an old version, except one withdrawn for security reasons. Source: `docs/PRODUCT_SPEC.md` §11.9.
10.2 We may stop or change a feature with notice. `[LAWYER: notice period]`

## 11. Confidentiality

Each side keeps the other's confidential information private and uses it only for this agreement. `[LAWYER: standard clause]`

## 12. Warranties, liability and indemnity

`[LAWYER: disclaimers; the liability cap ([LIABILITY CAP]); exclusions; indemnities, in particular for the Customer's monitoring of its staff and for safety incidents; insurance. The text must work with the safety limits in section 5.]`

## 13. Term and ending

13.1 The agreement lasts for `[TERM]` and then renews `[OWNER TO CONFIRM]`. Either side may end it as set out in `[LAWYER]`.
13.2 When it ends, the Customer can export its data and we delete it as set out in the DPA.

## 14. Governing law and disputes

`[GOVERNING LAW]`, `[COURTS OR ARBITRATION]`. `[LAWYER]`

## 15. Changes to these terms

We may change these terms with notice to the Customer `[LAWYER: how]`. The version in force is the one at `[DOMAIN]`.

## 16. Contact

`[COMPANY LEGAL NAME]`, `[COMPANY ADDRESS]`, support `[SUPPORT EMAIL]`, privacy `[PRIVACY EMAIL]`.
