# Money with Memory (MwM) — Business Plan

> Local AI negotiates. RGB settles. You stay in control.

Fonte dati: `README.md`, `compose.yaml`, `qvac.config.json`, `patches/`, `scripts/`. Le sezioni marcate **[Ipotesi]** non sono nel repository e vanno validate dal team.

## 1. Sintesi
MwM è un layer per swap peer-to-peer di asset digitali negoziati da agenti AI **locali** (QVAC, Qwen3-4B on-device) e regolati con **RGB su Bitcoin**. Ogni parte tiene privati budget e limiti; l'AI propone, controlli deterministici e approvazione umana 2/2 autorizzano il settlement. Stato attuale: pre-prodotto, validato solo su Bitcoin Regtest.

## 2. Problema
- Negoziare OTC/P2P espone prezzi di riserva e limiti: con LLM cloud o mempool pubblici l'informazione trapela.
- Gli agenti AI autonomi con poteri di spesa sono un rischio di sicurezza e fiducia.
- Il P2P trading richiede oggi controparti fidate o custodial intermediari.

## 3. Soluzione
1. **Set limits** – budget e vincoli privati, riserve principali in cold vault.
2. **Negotiate locally** – inferenza on-device, guardrail anti-leak.
3. **Review & approve** – bounds deterministici + sign-off di entrambe le parti.
4. **Settle with RGB** – atomic swap on-chain (BTC↔RGB, RGB↔RGB), validazione client-side, nessun custode.
Differenziatore: **counterparty memory** (storico interazioni per trust/risk check prima di impegnare capitale).

## 4. Stato del prodotto
| Pronto | Da costruire |
|---|---|
| Infrastruttura regtest (bitcoind, electrs, RGB proxy) in Docker | Negoziazione AI bilaterale |
| rgb-lib PR #85 pinnato + patch sperimentale | Validazione deterministica dei bounds |
| Suite di test: swap BTC↔RGB, RGB↔RGB, sicurezza consignment, 3-wallet hop, recovery | Counterparty memory |
| Config QVAC (Qwen3-4B Q4_K_M, ctx 8192) | UI/API di approvazione, integrazione Tether WDK |

## 5. Mercato e cliente **[Ipotesi]**
- **Primo cliente (wedge):** trader e piccoli desk OTC nativi Bitcoin/RGB, attenti alla privacy, che oggi trattano via chat/Telegram.
- **Secondari:** emittenti di asset RGB (stablecoin, token) che cercano liquidità non custodial; tesorerie di piccole aziende bitcoin-native.
- **Dimensionamento:** non presente nel repo — da stimare con interviste (TAM/SAM/SOM da validare, nessun numero inventato qui).
- **Perché ora:** RGB e stablecoin su Bitcoin in maturazione, LLM piccoli abbastanza buoni per girare in locale, crescente richiesta di agenti con human-in-the-loop.

## 6. Concorrenza
| Alternativa | Limite rispetto a MwM |
|---|---|
| Desk OTC centralizzati | Custodia, fiducia, KYC, nessuna privacy dei limiti |
| DEX / order book / AMM | Prezzi e intenti pubblici, slippage, MEV |
| Altri tool di swap RGB/Taproot Assets | Prezzo fisso/manuale, nessuna negoziazione automatica |
| Agenti trading cloud-LLM | Leak dei limiti, controllo non locale |
**Vantaggio difendibile:** privacy + non-custodia + approvazione umana, più dati di reputazione (memory) che crescono con l'uso.

## 7. Modello di business **[Ipotesi]**
Opzioni da testare, in ordine di preferenza:
1. **Fee sul volume regolato** (es. basis points per swap completato) — allineata al valore, poche frizioni.
2. **Licenza software/desk pro** (agenti multipli, policy avanzate, audit log).
3. **Servizi di integrazione** per emittenti RGB / stablecoin (Tether WDK).
Il software di base può restare open source (MIT) con monetizzazione su servizi pro e integrazioni.

## 8. Go-to-market
- **Fase 0 – Hackathon (17–18 ott 2026):** demo end-to-end su regtest, video + repo riproducibile (`reproduce_all.sh`).
- **Fase 1 – Community (mesi 1–3):** RGB Protocol Association, BitPolito, community Bitcoin/RGB italiane ed europee; pilot con 5–10 trader su testnet; raccolta feedback su soglie di fiducia.
- **Fase 2 – Pilot reali (mesi 3–6):** mainnet con limiti bassi, 1–2 emittenti RGB partner, metriche di successo pubbliche.
- **Fase 3 – Scala (mesi 6–18):** desk OTC piccoli, API, integrazione WDK, memory condivisa tra controparti (con privacy).
Canali: GitHub/open source, X e LinkedIn tecnici, talk e hackathon, partnership con emittenti.

## 9. Roadmap
| Quando | Obiettivo |
|---|---|
| Ott 2026 | Loop di negoziazione, bounds deterministici, UI di approvazione, demo regtest |
| Q4 2026 | Counterparty memory, hardening sicurezza, testnet pubblico |
| Q1–Q2 2027 | Audit esterno, mainnet limitata, integrazione Tether WDK |
| H2 2027 | API/SDK, multi-asset, funzionalità desk |

## 10. Team
Lu ([@OhItsLu](https://github.com/OhItsLu)), Safet ([@SafetH16](https://github.com/SafetH16)), Domi ([@DomiiCatiti](https://github.com/DomiiCatiti)). Ruoli e competenze da esplicitare **[Ipotesi]**; gap probabili: sicurezza/audit, business development, UX.

## 11. Rischi e mitigazioni
| Rischio | Mitigazione |
|---|---|
| Codice RGB sperimentale (PR #85 + patch) | Pin del commit, test di sicurezza, audit prima di mainnet |
| Solo regtest validato | Rollout graduale testnet → mainnet con cap sugli importi |
| Qualità del modello 4B nelle negoziazioni | Bounds deterministici fuori dall'AI; AI solo propone |
| Leak di limiti privati | Guardrail, esecuzione locale, test di leak |
| Liquidità/effetto rete iniziale | Wedge stretto, partnership con emittenti |
| Regolamentazione (VASP/AML) | Non custodia; parere legale prima di mainnet **[Ipotesi]** |
| Dipendenza da QVAC/Tether WDK | Interfaccia modello astratta (endpoint OpenAI-compatibile) |

## 12. Metriche
Swap completati; tasso negoziazione→settlement; tempo medio di chiusura; spread vs. prezzo di riferimento; violazioni dei guardrail (obiettivo 0); utenti ricorrenti; volume regolato.

## 13. Fabbisogno finanziario **[Ipotesi]**
Non presente nel repo. Voci da quantificare: audit di sicurezza, infrastruttura/nodi, legale, 2–3 FTE per 12 mesi. Fonti possibili: premi hackathon, grant (RGB/Bitcoin ecosystem, Tether), pre-seed.

## 14. Prossimi passi (30 giorni)
1. Completare il loop di negoziazione e la demo regtest.
2. 10 interviste a trader/emittenti RGB per validare cliente, prezzo e soglie di fiducia.
3. Definire il modello di fee e un budget a 12 mesi.
4. Candidarsi a grant e preparare un security review plan.
