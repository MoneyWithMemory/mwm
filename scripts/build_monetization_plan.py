#!/usr/bin/env python3
"""Genera MONETIZATION_PLAN.pdf (reportlab).

COME MODIFICARLO A MANO
- Ipotesi numeriche: sezione "IPOTESI" (volumi, take rate, desk, costi). Il PDF si ricalcola da solo.
- Testi e tabelle: sezione "CONTENUTI" (liste/stringhe Python).
- Rigenera con:  python3 scripts/build_monetization_plan.py
Requisiti: pip install reportlab
"""
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                PageBreak, KeepTogether, ListFlowable, ListItem)
from reportlab.graphics.shapes import Drawing, Rect, String, Line
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "MONETIZATION_PLAN.pdf")
TITOLO = "Money with Memory — Strategia di monetizzazione"
DATA = "Ottobre 2026"

# ========================= IPOTESI (modifica qui) =========================
PERIODI = ["Anno 1", "Anno 2", "Anno 3", "Anno 5"]
TAKE_RATE_BPS = [25, 20, 15, 12]          # fee sul volume regolato (1 bps = 0,01%)
PRO_DESK_USD_ANNO = 2400                  # abbonamento Pro per desk ($200/mese)
COSTI_USD = [150e3, 400e3, 900e3, 2.0e6]  # team, infrastruttura, audit, legale
SCENARI = {  # volume regolato (USD/anno), n. desk Pro, ricavi API/integrazioni, grant
    "Prudente":    {"vol": [0.2e6, 2e6, 8e6, 30e6],  "desk": [0, 4, 15, 50],   "api": [0, 10e3, 50e3, 200e3],  "grant": [40e3, 60e3, 30e3, 0]},
    "Base":        {"vol": [1e6, 10e6, 50e6, 250e6], "desk": [0, 10, 40, 150], "api": [0, 30e3, 150e3, 600e3], "grant": [60e3, 100e3, 50e3, 0]},
    "Ottimistico": {"vol": [4e6, 40e6, 200e6, 1000e6], "desk": [2, 30, 120, 400], "api": [10e3, 100e3, 500e3, 2e6], "grant": [100e3, 150e3, 50e3, 0]},
}
COLORI = {"Prudente": "#9aa5b1", "Base": "#F7931A", "Ottimistico": "#26A17B"}
ESEMPIO_SWAP_USD, ESEMPIO_BPS = 10000, 25

# ========================= CONTENUTI (modifica qui) =========================
SINTESI = ("MwM regola swap P2P tra asset RGB e Bitcoin senza custodia. Non detenendo fondi, il sistema non ha "
           "ricavi da spread o interessi sui depositi: la fonte naturale è la <b>fee sul volume regolato</b>. "
           "Dato che il codice è open source (MIT), la sola fee di protocollo è facile da aggirare con un fork; "
           "il piano combina quindi più fonti di ricavo.")
RACCOMANDAZIONE = ("<b>Raccomandazione.</b> (1) Fee di successo di 20–30 bps sul volume regolato, visibile nella schermata "
                   "di approvazione 2/2; (2) abbonamento Pro per desk/OTC; (3) servizi di counterparty memory e "
                   "integrazioni per emittenti RGB; (4) grant per finanziare il primo anno.")
MECCANISMI = [
    ["Meccanismo", "Come funziona", "Pro", "Contro"],
    ["A. Output di fee nella PSBT dello swap (consigliato)", "La transazione di swap include un output verso un indirizzo MwM; le parti la firmano dopo aver visto l'importo.", "Atomica: si paga solo se lo swap si chiude; trasparente; nessuna custodia.", "Un fork può rimuoverla; un output in più."],
    ["B. Fee a carico di una sola parte", "Pagata solo dal taker (o dal maker).", "Semplice; può premiare la liquidità dei maker.", "Può scoraggiare i taker."],
    ["C. Abbonamento / licenza", "Canone per funzioni Pro, non legato al volume.", "Ricavo prevedibile; non aggirabile con un fork.", "Servono funzioni davvero utili."],
    ["D. Servizi (relay, discovery, memory)", "Si paga l'accesso a orderbook privato, reputazione, API.", "Difendibile: valore dalla rete e dai dati.", "Serve massa critica."],
]
REGOLE = [
    "<b>Solo successo:</b> nessuna fee se la negoziazione non si chiude o lo swap fallisce.",
    "<b>Deterministica e fuori dall'AI:</b> la fee è calcolata dal codice; l'agente non può modificarla né negoziarla.",
    "<b>Trasparente:</b> importo e indirizzo mostrati prima della firma 2/2, con minimo (copre le fee on-chain) e tetto massimo.",
    "<b>Mai custodia:</b> MwM non tocca i fondi; la fee è un output della transazione firmata dalle parti.",
    "<b>Scaglioni:</b> es. 30 bps fino a $10k, 20 bps fino a $100k, 10 bps oltre; sconti per desk Pro.",
    "<b>Aspetto legale:</b> riscuotere commissioni su scambi di asset può avere rilevanza regolamentare (VASP/AML/MiCA): serve un parere legale prima della mainnet.",
]
FONTI = [
    ["Fonte", "Fase", "Descrizione", "Ipotesi di prezzo"],
    ["Fee sullo swap", "Medio–lungo", "Percentuale sul volume regolato", "25 → 12 bps"],
    ["Abbonamento Pro Desk", "Medio", "Agenti multipli, policy avanzate, audit log, SLA", "$200/mese per desk"],
    ["API e counterparty memory", "Medio–lungo", "Reputazione e risk-check delle controparti", "$10k–$50k/anno a contratto"],
    ["Integrazioni emittenti / Tether WDK", "Medio–lungo", "Setup, listing, supporto", "A progetto"],
    ["Grant e premi", "Breve", "Ecosistema RGB/Bitcoin, hackathon, Tether", "Non dilutivi, $40k–$150k/anno"],
]
BREVE = ["Finanziamento da grant, premi hackathon, eventuale pre-seed; ricavi da fee trascurabili.",
         "Obiettivo: demo funzionante, testnet pubblico, 5–10 utenti, meccanismo di fee implementato e provato (anche a 0 bps in pilot).",
         "Metriche: swap completati, tasso negoziazione→settlement, feedback sul prezzo accettabile."]
MEDIO = ["Mainnet con limiti, attivazione fee a scaglioni, lancio Pro Desk.",
         "Prima API di reputazione e primi contratti con emittenti RGB.",
         "La sostenibilità dipende dalla crescita del volume e dal controllo dei costi, non dal numero di funzioni."]
LUNGO = ["La counterparty memory diventa l'asset difendibile: più swap → migliore reputazione → più fiducia → più swap.",
         "Take rate in calo (verso 12 bps) compensato dal volume; peso crescente di abbonamenti e API."]
RISCHI = [
    ["Rischio", "Impatto", "Mitigazione"],
    ["Fork che rimuove la fee", "Perdita fee di protocollo", "Monetizzare servizi (memory, Pro, API), marchio e rete"],
    ["Volume troppo basso", "Ricavi sotto i costi", "Costi contenuti, grant, wedge stretto su RGB"],
    ["Pressione sulle fee", "Take rate più basso", "Competere su privacy e fiducia; scaglioni"],
    ["Normativa", "Obblighi di licenza/AML", "Parere legale prima della mainnet; non custodia"],
    ["Pochi emittenti/asset", "Concentrazione", "Più asset RGB; integrazione WDK/stablecoin"],
]
PROSSIMI = ["Scegliere il meccanismo di fee (consigliato: output nella PSBT) e provarlo su regtest.",
            "Parere legale su commissioni e custodia.",
            "Pilot con fee a 0 bps per misurare la disponibilità a pagare; poi test a 10–25 bps.",
            "10 interviste a trader/desk/emittenti per sostituire le ipotesi con dati reali.",
            "Candidarsi a grant per coprire il primo anno."]
AVVERTENZA = ("Le proiezioni sono scenari illustrativi con ipotesi stimate dall'autore, non dati di mercato né previsioni "
              "finanziarie. Non sono consulenza legale o d'investimento.")

# ========================= CALCOLI =========================
def money(x):
    if x < 0:
        return "−" + money(-x)
    return f"${x/1e6:.2f}M" if x >= 1e6 else f"${x/1e3:.0f}k"

def calcola(s):
    d, out = SCENARI[s], []
    for i in range(len(PERIODI)):
        fee = d["vol"][i] * TAKE_RATE_BPS[i] / 1e4
        extra = d["desk"][i] * PRO_DESK_USD_ANNO + d["api"][i]
        out.append(dict(vol=d["vol"][i], fee=fee, extra=extra, grant=d["grant"][i],
                        tot=fee + extra + d["grant"][i]))
    return out
R = {s: calcola(s) for s in SCENARI}

# ========================= STILI =========================
ORANGE = colors.HexColor("#F7931A")
ss = getSampleStyleSheet()
body = ParagraphStyle("body", parent=ss["BodyText"], fontName="Helvetica", fontSize=10, leading=14)
cell = ParagraphStyle("cell", parent=body, fontSize=8.5, leading=11)
cellb = ParagraphStyle("cellb", parent=cell, fontName="Helvetica-Bold")
h1 = ParagraphStyle("h1", parent=ss["Heading1"], fontSize=17, textColor=ORANGE, spaceBefore=14, spaceAfter=6, keepWithNext=1)
h2 = ParagraphStyle("h2", parent=ss["Heading2"], fontSize=12, spaceBefore=8, spaceAfter=4)
small = ParagraphStyle("small", parent=body, fontSize=8, textColor=colors.grey)
box = ParagraphStyle("box", parent=body, backColor=colors.HexColor("#FFF7EC"), borderColor=ORANGE,
                     borderWidth=0.8, borderPadding=7, spaceBefore=8, spaceAfter=10)
warn = ParagraphStyle("warn", parent=box, backColor=colors.HexColor("#FDF0EF"), borderColor=colors.HexColor("#c0392b"))

def P(t, st=body): return Paragraph(t, st)
def bullets(items): return ListFlowable([ListItem(P(t), leftIndent=12) for t in items], bulletType="bullet", start="•", leftIndent=12)
def numbered(items): return ListFlowable([ListItem(P(t), leftIndent=14) for t in items], bulletType="1", leftIndent=14)

def table(rows, widths=None, bold_first_col=False, header=True):
    data = []
    for r, row in enumerate(rows):
        data.append([P(str(c), cellb if (r == 0 and header) or (bold_first_col and i == 0) else cell) for i, c in enumerate(row)])
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    st = [("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cccccc")), ("VALIGN", (0, 0), (-1, -1), "TOP"),
          ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]
    if header: st.append(("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f4f4f4")))
    t.setStyle(TableStyle(st))
    return t

def grafico():
    W, H = 170 * mm, 70 * mm
    d = Drawing(W, H)
    mx = max(r["tot"] for s in R for r in R[s]) * 1.1
    base, top, left = 20, H - 18, 10
    y = lambda v: base + v / mx * (top - base)
    gw = (W - left) / len(PERIODI)
    for g, per in enumerate(PERIODI):
        x0 = left + g * gw + 8
        for k, s in enumerate(SCENARI):
            v = R[s][g]["tot"]
            d.add(Rect(x0 + k * 22, base, 18, y(v) - base, fillColor=colors.HexColor(COLORI[s]), strokeColor=None))
        d.add(Line(x0 - 3, y(COSTI_USD[g]), x0 + 66, y(COSTI_USD[g]), strokeColor=colors.HexColor("#c0392b"), strokeDashArray=[3, 2]))
        d.add(String(x0 + 31, 6, per, fontSize=8, textAnchor="middle"))
    d.add(Line(left, base, W, base, strokeColor=colors.grey))
    x = left
    for s in SCENARI:
        d.add(Rect(x, H - 11, 8, 8, fillColor=colors.HexColor(COLORI[s]), strokeColor=None))
        d.add(String(x + 11, H - 10, s, fontSize=8)); x += 70
    d.add(Line(x, H - 7, x + 14, H - 7, strokeColor=colors.HexColor("#c0392b"), strokeDashArray=[3, 2]))
    d.add(String(x + 17, H - 10, "Costi stimati", fontSize=8))
    return d

def footer(c, doc):
    c.saveState(); c.setFont("Helvetica", 8); c.setFillColor(colors.grey)
    c.drawString(18 * mm, 10 * mm, TITOLO); c.drawRightString(A4[0] - 18 * mm, 10 * mm, f"Pag. {doc.page}")
    c.restoreState()

def cover(c, doc):
    c.saveState(); c.setFillColor(ORANGE); c.rect(0, 0, 8 * mm, A4[1], fill=1, stroke=0)
    c.setFillColor(colors.black); c.setFont("Helvetica-Bold", 30); c.drawString(30 * mm, 170 * mm, "Money with Memory")
    c.setFont("Helvetica", 14); c.setFillColor(colors.HexColor("#555555"))
    c.drawString(30 * mm, 158 * mm, "Strategia di monetizzazione: fee, ricavi e proiezioni")
    c.drawString(30 * mm, 150 * mm, "a breve, medio e lungo termine")
    c.setFont("Helvetica", 9); c.drawString(30 * mm, 135 * mm, f"{DATA} — scenari illustrativi, non previsioni.")
    c.restoreState()

# ========================= DOCUMENTO =========================
def build():
    cw = 174 * mm
    s = [Spacer(1, 1), PageBreak()]
    s += [P("1. Sintesi", h1), P(SINTESI), P(RACCOMANDAZIONE, box)]
    s += [P("2. Come implementare le fee in un sistema non custodial", h1),
          table(MECCANISMI, [38*mm, 52*mm, 42*mm, 42*mm], bold_first_col=True),
          Spacer(1, 6), P("Regole di progetto", h2), bullets(REGOLE),
          Spacer(1, 4), P(f"Esempio: swap da ${ESEMPIO_SWAP_USD:,} con fee {ESEMPIO_BPS} bps = ${ESEMPIO_SWAP_USD*ESEMPIO_BPS/1e4:,.2f}.")]
    s += [PageBreak(), P("3. Fonti di ricavo", h1), table(FONTI, [48*mm, 26*mm, 62*mm, 38*mm], bold_first_col=True)]
    s += [P("4. Ipotesi del modello", h1),
          bullets([f"Take rate: " + ", ".join(f"{p} {b} bps" for p, b in zip(PERIODI, TAKE_RATE_BPS)) + ".",
                   f"Pro Desk: ${PRO_DESK_USD_ANNO:,}/anno per desk.",
                   "Costi stimati: " + ", ".join(f"{p} {money(c)}" for p, c in zip(PERIODI, COSTI_USD)) + ".",
                   "I volumi mostrano ordini di grandezza e <b>non</b> derivano da dati di mercato: vanno sostituiti dopo le interviste ai primi utenti."])]
    s += [PageBreak(), P("5. Proiezioni per scenario", h1)]
    rows = [["Periodo", "Volume regolato", "Ricavi da fee", "Pro + API", "Grant", "Totale", "Margine"]]
    for sc in SCENARI:
        rows.append([f"<b>{sc}</b>", "", "", "", "", "", ""])
        for i, per in enumerate(PERIODI):
            r = R[sc][i]
            rows.append([per, money(r["vol"]), money(r["fee"]), money(r["extra"]), money(r["grant"]),
                         f"<b>{money(r['tot'])}</b>", money(r["tot"] - COSTI_USD[i])])
    s += [table(rows, [24*mm, 28*mm, 26*mm, 24*mm, 22*mm, 24*mm, 26*mm]), Spacer(1, 8), grafico(),
          P("Barre: ricavi totali per scenario. Linea rossa tratteggiata: costi stimati. Margine = ricavi − costi.", small)]
    be = [sc for sc in SCENARI if any(R[sc][i]["tot"] >= COSTI_USD[i] for i in range(len(PERIODI)))]
    nob = [sc for sc in SCENARI if sc not in be]
    msg = ("<b>Risultato chiave.</b> Con queste ipotesi vanno in pareggio almeno in un periodo: " + (", ".join(be) or "nessuno scenario")
           + (". Non raggiungono mai il pareggio: " + ", ".join(nob) + " — per questi servono più volume, costi più bassi o finanziamenti esterni." if nob else "."))
    s += [P(msg, warn)]
    s += [P("6. Lettura per orizzonte temporale", h1),
          KeepTogether([P("Breve termine (0–12 mesi): costruire fiducia, non ricavi", h2), bullets(BREVE)]),
          KeepTogether([P("Medio termine (1–3 anni): primi ricavi ricorrenti", h2), bullets(MEDIO)]),
          KeepTogether([P("Lungo termine (3–5 anni): effetto rete", h2), bullets(LUNGO + [
              "Ricavi totali anno 5: " + ", ".join(f"{sc} {money(R[sc][-1]['tot'])}" for sc in SCENARI) + "."])])]
    s += [P("7. Rischi sul modello di ricavo", h1), table(RISCHI, [48*mm, 40*mm, 86*mm], bold_first_col=True)]
    s += [P("8. Prossimi passi", h1), numbered(PROSSIMI), P("Avvertenza. " + AVVERTENZA, warn)]
    doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=18*mm, rightMargin=18*mm, topMargin=18*mm, bottomMargin=18*mm,
                            title=TITOLO, author="Money with Memory")
    doc.build(s, onFirstPage=cover, onLaterPages=footer)
    print("scritto", os.path.abspath(OUT))

if __name__ == "__main__":
    build()
