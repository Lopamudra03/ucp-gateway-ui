import { useState, useRef, useEffect, useCallback } from "react";

// ─── DESIGN TOKENS ────────────────────────────────────────────────────────────
const C = {
  red:        "#CC1F1F",
  redLight:   "#FEF2F2",
  redBorder:  "#FECACA",
  green:      "#10B981",
  greenLight: "#ECFDF5",
  greenBorder:"#6EE7B7",
  amber:      "#F59E0B",
  amberLight: "#FFFBEB",
  amberBorder:"#FCD34D",
  border:     "#E5E7EB",
  bg:         "#FFFFFF",
  bgMuted:    "#F9FAFB",
  text:       "#111827",
  textSub:    "#6B7280",
  textMuted:  "#9CA3AF",
};

// ─── UCP FIELD REGISTRY (matching engine) ────────────────────────────────────
const UCP_KEYWORDS = {
  "offer.id":             ["id","offerid","productid","itemid","sku"],
  "offer.name":           ["modelname","name","productname","title","label","offername","model","devicename"],
  "offer.description":    ["description","desc","summary","detail","longdescription"],
  "offer.price.amount":   ["price","amount","cost","value","pricevalue","listprice"],
  "offer.price.currency": ["currency","currencycode","unit","priceunit","iso"],
  "offer.category":       ["category","type","class","group","segment"],
  "offer.status":         ["status","lifecyclestatus","state","active","enabled"],
  "offer.validFor":       ["validfor","startdate","enddate","expirydate","validity"],
  "user.id":              ["userid","customerid","accountid","uid","subjectid"],
  "user.email":           ["email","emailaddress","contactemail","mail"],
  "user.firstName":       ["firstname","givenname","fname","first"],
  "user.lastName":        ["lastname","familyname","surname","lname","last"],
  "user.phone":           ["phone","phonenumber","mobile","contact","msisdn"],
  "user.address":         ["address","streetaddress","location","street"],
  "user.accountStatus":   ["accountstatus","userstatus","memberstatus"],
  "cart.id":              ["cartid","basketid","sessionid","shoppingcartid"],
  "cart.items":           ["items","cartitems","products","entries","lineitem"],
  "cart.total":           ["total","subtotal","totalamount","carttotal","grandtotal"],
  "cart.currency":        ["currency","currencycode","billingcurrency"],
  "cart.expiresAt":       ["expiresat","expiry","timeout","ttl"],
  "order.id":             ["orderid","ordernumber","transactionid","referenceid"],
  "order.status":         ["orderstatus","fulfillmentstatus","deliverystatus"],
  "order.date":           ["orderdate","date","createdat","timestamp","orderedon"],
  "order.total":          ["ordertotal","total","orderamount","grandtotal"],
  "order.items":          ["orderitems","lineitems","products","orderlines"],
  "payment.id":           ["paymentid","transactionid","paymentref","invoiceid"],
  "payment.method":       ["paymentmethod","method","paymenttype","instrument"],
  "payment.status":       ["paymentstatus","transactionstatus","settlementstatus"],
  "payment.amount":       ["paymentamount","amount","chargedamount","total"],
};
const ALL_UCP_FIELDS = Object.keys(UCP_KEYWORDS);

// ─── SWAGGER PARSER ───────────────────────────────────────────────────────────
function resolveRef(ref, spec) {
  if (!ref?.startsWith("#/")) return null;
  return ref.replace("#/", "").split("/").reduce((o, k) => o?.[k], spec) || null;
}

function flattenSchema(schema, spec, prefix = "", depth = 0) {
  if (depth > 4 || !schema) return [];
  if (schema.$ref) schema = resolveRef(schema.$ref, spec) || {};
  if (schema.allOf) return schema.allOf.flatMap(s => flattenSchema(s, spec, prefix, depth));
  if (schema.oneOf || schema.anyOf)
    return flattenSchema((schema.oneOf || schema.anyOf)[0], spec, prefix, depth);
  const fields = [];
  if (schema.properties) {
    for (const [name, rawProp] of Object.entries(schema.properties)) {
      const prop = rawProp.$ref ? resolveRef(rawProp.$ref, spec) || rawProp : rawProp;
      const fullName = prefix ? `${prefix}.${name}` : name;
      if (prop.properties || prop.type === "object") {
        fields.push(...flattenSchema(prop, spec, fullName, depth + 1));
      } else if (prop.type === "array" && prop.items) {
        fields.push({ name: fullName, type: "array" });
        const item = prop.items.$ref ? resolveRef(prop.items.$ref, spec) : prop.items;
        if (item?.properties && depth < 3)
          fields.push(...flattenSchema(item, spec, fullName + "[]", depth + 1));
      } else {
        fields.push({ name: fullName, type: prop.type || "string" });
      }
    }
  } else if (schema.type === "array" && schema.items) {
    const item = schema.items.$ref ? resolveRef(schema.items.$ref, spec) : schema.items;
    fields.push(...flattenSchema(item, spec, prefix, depth + 1));
  }
  return fields;
}

function parseSwaggerContent(text) {
  let spec;
  try { spec = JSON.parse(text); }
  catch { throw new Error("YAML detected — please export your spec as JSON."); }
  const endpoints = [];
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of ["get","post","put","patch","delete"]) {
      const op = pathItem[method];
      if (!op) continue;
      const reqFields = [];
      const resFields = [];
      const rb = op.requestBody?.content?.["application/json"] ||
                 Object.values(op.requestBody?.content || {})[0];
      if (rb?.schema) reqFields.push(...flattenSchema(rb.schema, spec));
      for (const rawParam of op.parameters || []) {
        const param = rawParam.$ref ? resolveRef(rawParam.$ref, spec) || rawParam : rawParam;
        if (param.in !== "header")
          reqFields.push({ name: param.name, type: param.schema?.type || param.type || "string" });
      }
      const rawResp = op.responses?.["200"] || op.responses?.["201"];
      const resp    = rawResp?.$ref ? resolveRef(rawResp.$ref, spec) : rawResp;
      const rc      = resp?.content?.["application/json"] || Object.values(resp?.content || {})[0];
      const rs      = rc?.schema || resp?.schema;
      if (rs) resFields.push(...flattenSchema(rs, spec));
      const allFields = [
        ...[...new Map(reqFields.map(f => [f.name, f])).values()].slice(0, 30).map(f => ({ ...f, fieldSource: "request" })),
        ...[...new Map(resFields.map(f => [f.name, f])).values()].slice(0, 20).map(f => ({ ...f, fieldSource: "response" })),
      ];
      if (allFields.length) endpoints.push({
        method: method.toUpperCase(), path,
        label:  `${method.toUpperCase()} ${path}`,
        fields: allFields,
      });
    }
  }
  return { title: spec.info?.title || "Uploaded API", version: spec.info?.version || "", endpoints };
}

// Domain priority: lower index wins tiebreaks (offer first, user last)
const DOMAIN_PRIORITY = ["offer.", "cart.", "order.", "payment.", "user."];
function _domainRank(ucpField) {
  const i = DOMAIN_PRIORITY.findIndex(d => ucpField.startsWith(d));
  return i === -1 ? 99 : i;
}

function matchToUcp(fieldName, used = new Set(), endpointPath = "") {
  const norm = fieldName.toLowerCase().replace(/[.\-_[\]]/g, "");
  // Context string used for domain-boost heuristics
  const ctx  = (endpointPath + " " + fieldName).toLowerCase();

  // Per-domain context boost (+12) when endpoint path or field name hints at that domain
  const domainBoost = {
    "offer.":   /product|offer|catalog|device|item|sku|model|brand|price/.test(ctx) ? 12 : 0,
    "user.":    /user|customer|account|person|profile|contact/.test(ctx)             ? 12 : 0,
    "cart.":    /cart|basket|shopping/.test(ctx)                                      ? 12 : 0,
    "order.":   /order|purchase|transaction/.test(ctx)                                ? 12 : 0,
    "payment.": /payment|pay|invoice|bill|charge/.test(ctx)                           ? 12 : 0,
  };

  let best = null, bestScore = 0;

  for (const [ucpField, kws] of Object.entries(UCP_KEYWORDS)) {
    if (used.has(ucpField)) continue;
    let fieldScore = 0;
    for (const kw of kws) {
      const k = kw.toLowerCase();
      let s = 0;
      if (norm === k)                                 s = 100;                              // exact match
      else if (norm.includes(k) && k.length > 2)     s = (k.length / norm.length) * 85;   // norm contains keyword
      else if (k.includes(norm) && norm.length > 2)  s = (norm.length / k.length) * 75;   // keyword contains norm
      if (s > fieldScore) fieldScore = s;
    }
    if (fieldScore === 0) continue;

    // Add context boost for matching domain prefix
    const prefix = DOMAIN_PRIORITY.find(d => ucpField.startsWith(d)) ?? "";
    const total  = fieldScore + (domainBoost[prefix] ?? 0);

    // Prefer higher score; break ties by domain priority (offer.* beats user.* etc.)
    if (total > bestScore ||
       (total === bestScore && _domainRank(ucpField) < _domainRank(best ?? ""))) {
      bestScore = total;
      best = ucpField;
    }
  }

  if (bestScore < 25) return { ucpField: null, status: "unmapped", confidence: 0 };
  // Deterministic confidence — no random jitter
  const conf = Math.min(99, Math.round(bestScore * 0.9));
  return { ucpField: best, status: conf >= 68 ? "auto" : "review", confidence: conf };
}

function generateMappings(parsedSpec) {
  let id = 0;
  // Separate used-sets so response fields get a fresh matching pool and don't
  // inherit exhausted UCP fields from the request side.
  const usedReq = new Set();
  const usedRes = new Set();
  return parsedSpec.endpoints.flatMap(ep =>
    ep.fields.map(field => {
      const isResponse = field.fieldSource === "response";
      const used = isResponse ? usedRes : usedReq;
      const m = matchToUcp(field.name, used, ep.path);
      if (m.ucpField) used.add(m.ucpField);
      return { id: ++id, apiField: field.name, apiType: field.type, apiEndpoint: ep.label, fieldSource: field.fieldSource || "request", ...m };
    })
  );
}

// ─── SAMPLE SPECS ─────────────────────────────────────────────────────────────
const SAMPLES = {
  "TMF620 Product Catalog": { info: { title: "TMF620 Product Catalog API", version: "4.0.0" }, paths: { "/productOffering": { get: { parameters: [{ name: "fields", in: "query", schema: { type: "string" } }, { name: "offset", in: "query", schema: { type: "integer" } }], responses: { "200": { content: { "application/json": { schema: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, lifecycleStatus: { type: "string" }, validFor: { type: "object", properties: { startDateTime: { type: "string" }, endDateTime: { type: "string" } } }, productOfferingPrice: { type: "array", items: { type: "object", properties: { value: { type: "number" }, unit: { type: "string" } } } }, category: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } } } } } } } } }, "/shoppingCart": { post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { cartId: { type: "string" }, customerId: { type: "string" }, cartItems: { type: "array" }, totalAmount: { type: "number" }, currency: { type: "string" } } } } } }, responses: { "201": { content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } } } } } } } }, "/order": { post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { orderId: { type: "string" }, orderDate: { type: "string" }, orderStatus: { type: "string" }, orderTotal: { type: "number" }, customerId: { type: "string" }, orderItems: { type: "array" } } } } } }, responses: { "201": { content: { "application/json": { schema: { type: "object", properties: { orderId: { type: "string" } } } } } } } } } } },
  "Mobile Device API": { info: { title: "Mobile Device Catalog", version: "2.1" }, paths: { "/devices": { get: { responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { modelName: { type: "string" }, brand: { type: "string" }, sku: { type: "string" }, color: { type: "string" }, priceValue: { type: "number" }, priceUnit: { type: "string" }, category: { type: "string" }, lifecycleStatus: { type: "string" }, inStock: { type: "boolean" } } } } } } } } }, "/cart": { post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { basketId: { type: "string" }, userId: { type: "string" }, lineItems: { type: "array" }, grandTotal: { type: "number" }, billingCurrency: { type: "string" } } } } } }, responses: { "201": { content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } } } } } }, "/payment": { post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { paymentId: { type: "string" }, paymentMethod: { type: "string" }, chargedAmount: { type: "number" }, paymentStatus: { type: "string" }, msisdn: { type: "string" } } } } } }, responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" } } } } } } } } } } },
};

// ─── STATIC LEFT PANEL DATA ───────────────────────────────────────────────────
const UCP_LEFT = [
  { id: "catalog", label: "CATALOG.SEARCH", badge: "5/5", fields: [
    { name: "offer.id",             type: "str", req: true  },
    { name: "offer.name",           type: "str", req: true  },
    { name: "offer.price.amount",   type: "num", req: true  },
    { name: "offer.price.currency", type: "str", req: false },
    { name: "offer.description",    type: "str", req: false },
  ]},
  { id: "cart", label: "CART", badge: "3/5", fields: [
    { name: "cart.id",        type: "str", req: true  },
    { name: "cart.items",     type: "arr", req: true  },
    { name: "cart.total",     type: "num", req: true  },
    { name: "cart.currency",  type: "str", req: false },
    { name: "cart.expiresAt", type: "str", req: false },
  ]},
  { id: "checkout", label: "CHECKOUT", badge: "2/4", fields: [
    { name: "user.id",        type: "str", req: true  },
    { name: "user.email",     type: "str", req: true  },
    { name: "user.firstName", type: "str", req: false },
    { name: "user.lastName",  type: "str", req: false },
  ]},
  { id: "order", label: "ORDER", badge: "4/6", fields: [
    { name: "order.id",     type: "str", req: true  },
    { name: "order.status", type: "str", req: true  },
    { name: "order.date",   type: "str", req: true  },
    { name: "order.total",  type: "num", req: true  },
    { name: "order.items",  type: "arr", req: false },
  ]},
  { id: "payment", label: "PAYMENT", badge: "1/3", fields: [
    { name: "payment.id",     type: "str", req: true  },
    { name: "payment.method", type: "str", req: true  },
    { name: "payment.status", type: "str", req: false },
  ]},
];

// ─── PRIMITIVE ICONS ─────────────────────────────────────────────────────────
function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}
function IconChevron({ open }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.18s ease" }}>
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}
function IconArrowRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
    </svg>
  );
}
function IconCheck({ color }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color || C.green} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}
function IconX() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}
function IconUpload() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  );
}
function IconPlay() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  );
}
function IconSave() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
    </svg>
  );
}
function IconSpark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
    </svg>
  );
}
function IconDrop() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={C.border} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  );
}
function IconKebab() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={C.textSub}>
      <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
    </svg>
  );
}
function IconSpin() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ animation: "spin 0.8s linear infinite" }}>
      <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" strokeWidth="3"/>
      <path d="M12 2a10 10 0 0 1 10 10" stroke="white" strokeWidth="3" strokeLinecap="round"/>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </svg>
  );
}

// ─── SHARED PRIMITIVES ────────────────────────────────────────────────────────
function SearchInput({ value, onChange, placeholder }) {
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <span style={{ position: "absolute", left: 9, color: C.textMuted, display: "flex" }}>
        <IconSearch />
      </span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%", paddingLeft: 30, paddingRight: 10, paddingTop: 7, paddingBottom: 7,
          fontSize: 12, border: `1px solid ${C.border}`, borderRadius: 6,
          outline: "none", background: C.bgMuted, color: C.text, fontFamily: "inherit",
          boxSizing: "border-box",
        }}
        onFocus={e => e.target.style.borderColor = C.red}
        onBlur={e => e.target.style.borderColor = C.border}
      />
    </div>
  );
}

function SectionHeader({ dot, label, count }) {
  const dotColors = { amber: C.amber, green: C.green, red: C.red };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColors[dot], flexShrink: 0 }} />
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: C.textSub, textTransform: "uppercase" }}>
        {label}
      </span>
      <span style={{
        fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 99,
        background: dot === "amber" ? C.amberLight : dot === "green" ? C.greenLight : C.redLight,
        color:      dot === "amber" ? "#92400E"    : dot === "green" ? "#065F46"    : C.red,
        border:     `1px solid ${dot === "amber" ? C.amberBorder : dot === "green" ? C.greenBorder : C.redBorder}`,
      }}>
        {count}
      </span>
    </div>
  );
}

// ─── NAVBAR ───────────────────────────────────────────────────────────────────
function Navbar({ parsedSpec, uploadError, onFileLoaded, onGenerate, generating, canGenerate, ucpVersion, setUcpVersion }) {
  const inputRef   = useRef();
  const [samplesOpen, setSamplesOpen] = useState(false);

  const processFile = (text, name) => {
    try {
      const result = parseSwaggerContent(text);
      onFileLoaded(result, name, result.endpoints.length === 0
        ? "No endpoints found — check that your spec has a non-empty 'paths' object."
        : null);
    } catch (err) {
      onFileLoaded(null, name, err.message);
    }
  };

  const handleChange = e => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = ev => processFile(ev.target.result, f.name);
    reader.readAsText(f);
    e.target.value = "";
  };

  const loadSample = name => {
    setSamplesOpen(false);
    processFile(JSON.stringify(SAMPLES[name]), `${name}.json`);
  };

  const btn = (label, onClick, opts = {}) => (
    <button onClick={onClick} disabled={opts.disabled}
      style={{
        display: "flex", alignItems: "center", gap: 5,
        padding: "6px 12px", fontSize: 12, fontWeight: 600, borderRadius: 6,
        cursor: opts.disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
        transition: "opacity 0.15s",
        opacity: opts.disabled ? 0.45 : 1,
        background:   opts.primary ? C.red  : "white",
        color:        opts.primary ? "white" : C.text,
        border:       opts.primary ? "none"  : `1px solid ${C.border}`,
      }}
      onMouseEnter={e => !opts.disabled && (e.currentTarget.style.opacity = "0.88")}
      onMouseLeave={e => (e.currentTarget.style.opacity = opts.disabled ? "0.45" : "1")}
    >
      {opts.icon}{label}
    </button>
  );

  return (
    <header style={{
      display: "flex", alignItems: "center", padding: "0 20px", height: 52,
      borderBottom: `1px solid ${C.border}`, background: C.bg, flexShrink: 0, gap: 12,
    }}>
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <div style={{ width: 28, height: 28, borderRadius: 6, background: C.red, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
            <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
          </svg>
        </div>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text, letterSpacing: "-0.01em" }}>UCP Gateway Portal</span>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
          background: "#FFFBEB", color: "#92400E", border: "1px solid #FCD34D", letterSpacing: "0.05em",
        }}>SANDBOX</span>
      </div>

      {/* File status pill */}
      {(parsedSpec || uploadError) && (
        <div style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "3px 10px", borderRadius: 20, fontSize: 11,
          background: uploadError ? C.redLight : C.greenLight,
          border: `1px solid ${uploadError ? C.redBorder : C.greenBorder}`,
          color: uploadError ? C.red : "#065F46",
          maxWidth: 260, overflow: "hidden",
        }}>
          {uploadError
            ? <IconX />
            : <IconCheck color={C.green} />}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {uploadError || `${parsedSpec?.title} · ${parsedSpec?.endpoints.length} endpoints`}
          </span>
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* Actions */}
      <input ref={inputRef} type="file" accept=".json,.yaml,.yml" style={{ display: "none" }} onChange={handleChange} />

      {btn("Upload Swagger", () => inputRef.current.click(), { icon: <IconUpload /> })}

      {/* Samples */}
      <div style={{ position: "relative" }}>
        {btn("Samples", () => setSamplesOpen(v => !v), { icon: <IconChevron open={samplesOpen} /> })}
        {samplesOpen && (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setSamplesOpen(false)} />
            <div style={{
              position: "absolute", right: 0, top: "calc(100% + 6px)", width: 200,
              background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,0.1)", zIndex: 50, overflow: "hidden",
            }}>
              {Object.keys(SAMPLES).map(name => (
                <button key={name} onClick={() => loadSample(name)}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "9px 14px", fontSize: 12, color: C.text,
                    background: "none", border: "none", cursor: "pointer", fontFamily: "inherit",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = C.bgMuted}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}
                >
                  {name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <select value={ucpVersion} onChange={e => setUcpVersion(e.target.value)}
        style={{
          fontSize: 12, fontWeight: 600, padding: "6px 8px", borderRadius: 6,
          border: `1px solid ${C.border}`, background: C.bg, color: C.text,
          cursor: "pointer", outline: "none", fontFamily: "inherit",
        }}>
        <option>UCP v2.4</option>
        <option>UCP v2.3</option>
        <option>UCP v2.2</option>
      </select>

      {btn(
        generating ? "Generating…" : "Generate Mapping",
        onGenerate,
        { primary: true, disabled: !canGenerate || generating, icon: generating ? <IconSpin /> : <IconSpark /> }
      )}

      <button style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", borderRadius: 4 }}
        onMouseEnter={e => e.currentTarget.style.background = C.bgMuted}
        onMouseLeave={e => e.currentTarget.style.background = "none"}>
        <IconKebab />
      </button>
    </header>
  );
}

// ─── LEFT PANEL ───────────────────────────────────────────────────────────────
function LeftPanel() {
  const [search, setSearch]       = useState("");
  const [openGroups, setOpenGroups] = useState({ catalog: true });
  const toggle = id => setOpenGroups(p => ({ ...p, [id]: !p[id] }));

  return (
    <div style={{
      width: 260, minWidth: 260, display: "flex", flexDirection: "column",
      borderRight: `1px solid ${C.border}`, background: C.bg, overflow: "hidden",
    }}>
      {/* Panel header */}
      <div style={{ padding: "12px 16px 10px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/>
            <line x1="12" y1="7" x2="5" y2="17"/><line x1="12" y1="7" x2="19" y2="17"/>
          </svg>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>UCP Capabilities</span>
        </div>
        <SearchInput value={search} onChange={setSearch} placeholder="Search capabilities…" />
      </div>

      {/* Accordion */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {UCP_LEFT.map(group => {
          const isActive = group.id === "catalog";
          const isOpen   = openGroups[group.id];
          const filtered = group.fields.filter(f =>
            !search || f.name.toLowerCase().includes(search.toLowerCase())
          );
          return (
            <div key={group.id}>
              <button onClick={() => toggle(group.id)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 7,
                  padding: "9px 14px 9px 12px", background: isActive ? "#FEF2F2" : "none",
                  borderLeft: `3px solid ${isActive ? C.red : "transparent"}`,
                  border: "none", borderLeft: `3px solid ${isActive ? C.red : "transparent"}`,
                  cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                  transition: "background 0.1s",
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = C.bgMuted; }}
                onMouseLeave={e => { e.currentTarget.style.background = isActive ? "#FEF2F2" : "none"; }}
              >
                <span style={{ color: C.textMuted }}><IconChevron open={isOpen} /></span>
                <span style={{ flex: 1, fontSize: 11.5, fontWeight: 700, color: isActive ? C.red : C.textSub, letterSpacing: "0.03em", textTransform: "uppercase" }}>
                  {group.label}
                </span>
                <span style={{
                  fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 4,
                  background: isActive ? C.redLight : "#F3F4F6", color: isActive ? C.red : C.textSub,
                  border: `1px solid ${isActive ? C.redBorder : C.border}`,
                }}>
                  {group.badge}
                </span>
              </button>

              {isOpen && filtered.length > 0 && (
                <div style={{ paddingBottom: 2 }}>
                  {filtered.map(f => (
                    <div key={f.name}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: "5px 14px 5px 32px", cursor: "default",
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = C.bgMuted}
                      onMouseLeave={e => e.currentTarget.style.background = "none"}
                    >
                      <span style={{ fontSize: 11.5, fontFamily: "'JetBrains Mono', 'Fira Code', monospace", color: C.textSub }}>
                        {f.name}
                        {f.req && <span style={{ color: C.red, marginLeft: 1 }}>*</span>}
                        {" "}
                        <span style={{ color: C.textMuted, fontSize: 10.5 }}>({f.type})</span>
                      </span>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, flexShrink: 0 }} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── EDIT MAPPING MODAL ───────────────────────────────────────────────────────
function EditMappingModal({ mapping, onSave, onClose }) {
  const [val, setVal] = useState(mapping.ucpField || "");
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.35)" }} onClick={onClose} />
      <div style={{
        position: "relative", background: C.bg, borderRadius: 10, width: 440,
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)", overflow: "hidden", zIndex: 1,
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>Edit Mapping</span>
          <button onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: C.textMuted, display: "flex", borderRadius: 4 }}
            onMouseEnter={e => { e.currentTarget.style.background = C.bgMuted; e.currentTarget.style.color = C.text; }}
            onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = C.textMuted; }}
          ><IconX /></button>
        </div>
        {/* Body */}
        <div style={{ padding: "18px 18px 14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "center" }}>
            <div style={{ background: C.bgMuted, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px" }}>
              <p style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Source (API)</p>
              <p style={{ fontSize: 12, fontFamily: "'JetBrains Mono','Fira Code',monospace", fontWeight: 600, color: C.text, margin: 0, wordBreak: "break-all" }}>{mapping.apiField}</p>
            </div>
            <IconArrowRight />
            <div style={{ background: C.redLight, border: `1px solid ${C.redBorder}`, borderRadius: 6, padding: "8px 10px" }}>
              <p style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Target (UCP)</p>
              <select value={val} onChange={e => setVal(e.target.value)}
                style={{
                  width: "100%", fontSize: 12, fontFamily: "'JetBrains Mono','Fira Code',monospace",
                  fontWeight: 600, color: C.red, background: "transparent",
                  border: "none", outline: "none", cursor: "pointer", padding: 0,
                }}>
                <option value="">— none —</option>
                {ALL_UCP_FIELDS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
          </div>
        </div>
        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 18px", borderTop: `1px solid ${C.border}`, background: C.bgMuted }}>
          <button onClick={onClose}
            style={{ padding: "7px 16px", fontSize: 12, fontWeight: 600, borderRadius: 6, border: `1px solid ${C.border}`, background: C.bg, color: C.text, cursor: "pointer", fontFamily: "inherit" }}
            onMouseEnter={e => e.currentTarget.style.background = C.bgMuted}
            onMouseLeave={e => e.currentTarget.style.background = C.bg}
          >Cancel</button>
          <button onClick={() => onSave(val)}
            style={{ padding: "7px 16px", fontSize: 12, fontWeight: 700, borderRadius: 6, border: "none", background: C.red, color: "white", cursor: "pointer", fontFamily: "inherit" }}
            onMouseEnter={e => e.currentTarget.style.opacity = "0.88"}
            onMouseLeave={e => e.currentTarget.style.opacity = "1"}
          >Save</button>
        </div>
      </div>
    </div>
  );
}

// ─── CENTER PANEL ─────────────────────────────────────────────────────────────
function CenterPanel({ mappings, setMappings, hasMapping }) {
  const [tab,       setTab]     = useState("request");
  const [coverageW, setCov]     = useState(0);
  const [saved,     setSaved]   = useState(false);
  const [editId,    setEditId]  = useState(null);
  const [checked,   setChecked] = useState(new Set());

  const tabMappings = mappings?.filter(m => m.fieldSource === tab) || [];
  const review   = tabMappings.filter(m => m.status === "review");
  const auto     = tabMappings.filter(m => m.status === "auto" || m.status === "confirmed");
  const unmapped = tabMappings.filter(m => m.status === "unmapped");

  const allAuto   = mappings?.filter(m => m.status === "auto" || m.status === "confirmed") || [];
  const allReview = mappings?.filter(m => m.status === "review") || [];
  const total     = mappings?.length || 1;
  const coverage  = mappings ? Math.round(((allAuto.length + allReview.length * 0.5) / total) * 100) : 0;

  useEffect(() => {
    const t = setTimeout(() => setCov(coverage), 250);
    return () => clearTimeout(t);
  }, [coverage]);

  // Reset checkboxes when tab or mappings change
  useEffect(() => { setChecked(new Set()); }, [tab, mappings]);

  const changeUcp = (id, val, forceStatus) => setMappings(m => m.map(r => r.id === id
    ? { ...r, ucpField: val || null, status: forceStatus || (val ? "review" : "unmapped") } : r));

  const confirmSelected = () => {
    setMappings(m => m.map(r => checked.has(r.id) ? { ...r, status: "confirmed" } : r));
    setChecked(new Set());
  };

  const toggleCheck = id => setChecked(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const editingMapping = editId != null ? mappings?.find(m => m.id === editId) : null;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: C.bg }}>

      {editingMapping && (
        <EditMappingModal
          mapping={editingMapping}
          onClose={() => setEditId(null)}
          onSave={val => { changeUcp(editId, val, val ? "auto" : "unmapped"); setEditId(null); }}
        />
      )}

      {/* Sub-header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 20px", height: 52, borderBottom: `1px solid ${C.border}`, flexShrink: 0, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.red} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
          </svg>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Mapping Workspace</span>
        </div>
        <div style={{ flex: 1 }} />
        {hasMapping && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Coverage</span>
              <div style={{ width: 90, height: 6, background: "#F3F4F6", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 99, background: C.red, width: `${coverageW}%`, transition: "width 1.2s cubic-bezier(0.4,0,0.2,1)" }} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.red, minWidth: 32 }}>{coverage}%</span>
            </div>
            <button style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 11px", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer", background: "white", color: C.text, border: `1px solid ${C.border}`, fontFamily: "inherit" }}
              onMouseEnter={e => e.currentTarget.style.background = C.bgMuted}
              onMouseLeave={e => e.currentTarget.style.background = "white"}
            ><IconPlay /> Run Test</button>
            <button onClick={() => { setSaved(true); setTimeout(() => setSaved(false), 2200); }}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 11px", fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: "pointer", background: saved ? "#059669" : C.red, color: "white", border: "none", fontFamily: "inherit", transition: "background 0.2s" }}
            >{saved ? <IconCheck color="white" /> : <IconSave />}{saved ? "Saved" : "Save to DB"}</button>
          </>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, padding: "0 20px", flexShrink: 0, background: C.bg }}>
        {[["request","Request Mapping"],["response","Response Mapping"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{
              padding: "10px 0", marginRight: 24, fontSize: 12.5, fontWeight: 600,
              borderBottom: `2px solid ${tab === id ? C.red : "transparent"}`,
              color: tab === id ? C.red : C.textSub,
              background: "none", border: "none", cursor: "pointer",
              fontFamily: "inherit", transition: "color 0.15s",
            }}>{label}</button>
        ))}
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: "auto", padding: 20, background: C.bgMuted }}>
        {!hasMapping ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", textAlign: "center", padding: 40 }}>
            <div style={{ width: 56, height: 56, borderRadius: 12, background: C.bg, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 14, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={C.border} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
              </svg>
            </div>
            <p style={{ fontSize: 14, fontWeight: 600, color: C.textSub, marginBottom: 6 }}>No mapping loaded</p>
            <p style={{ fontSize: 12, color: C.textMuted, maxWidth: 300, lineHeight: 1.6 }}>
              Upload a Swagger / OpenAPI file and click <strong style={{ color: C.text }}>Generate Mapping</strong> to auto-map your API fields to UCP capabilities.
            </p>
          </div>
        ) : tabMappings.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", textAlign: "center", padding: 40 }}>
            <div style={{ width: 48, height: 48, borderRadius: 10, background: C.bg, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>
              </svg>
            </div>
            <p style={{ fontSize: 13, fontWeight: 600, color: C.textSub, marginBottom: 5 }}>No {tab} fields found</p>
            <p style={{ fontSize: 12, color: C.textMuted, maxWidth: 280, lineHeight: 1.6 }}>
              {tab === "response"
                ? "This spec has no response schema fields. Only endpoints with a 200/201 response body will appear here."
                : "No request body or query parameters were found in the uploaded spec."}
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* ── NEEDS REVIEW ── */}
            {review.length > 0 && (
              <section>
                {/* Toolbar: dot + label + count + Select All | Unselect All + Confirm Selected */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.amber, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: C.textSub, textTransform: "uppercase" }}>Needs Review</span>
                  <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 99, background: C.amberLight, color: "#92400E", border: `1px solid ${C.amberBorder}` }}>{review.length}</span>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => setChecked(new Set(review.map(r => r.id)))}
                    style={{ fontSize: 11.5, fontWeight: 600, color: C.textSub, background: "none", border: "none", cursor: "pointer", padding: "2px 4px", borderRadius: 4, fontFamily: "inherit" }}
                    onMouseEnter={e => e.currentTarget.style.color = C.text}
                    onMouseLeave={e => e.currentTarget.style.color = C.textSub}
                  >Select All</button>
                  <span style={{ color: C.border }}>|</span>
                  <button onClick={() => setChecked(new Set())}
                    style={{ fontSize: 11.5, fontWeight: 600, color: C.textSub, background: "none", border: "none", cursor: "pointer", padding: "2px 4px", borderRadius: 4, fontFamily: "inherit" }}
                    onMouseEnter={e => e.currentTarget.style.color = C.text}
                    onMouseLeave={e => e.currentTarget.style.color = C.textSub}
                  >Unselect All</button>
                  <button onClick={confirmSelected} disabled={checked.size === 0}
                    style={{
                      display: "flex", alignItems: "center", gap: 5,
                      padding: "5px 12px", fontSize: 12, fontWeight: 700, borderRadius: 6,
                      cursor: checked.size === 0 ? "not-allowed" : "pointer",
                      background: checked.size === 0 ? "#F3F4F6" : C.red,
                      color: checked.size === 0 ? C.textMuted : "white",
                      border: "none", fontFamily: "inherit", transition: "background 0.15s",
                      opacity: 1,
                    }}
                    onMouseEnter={e => { if (checked.size > 0) e.currentTarget.style.opacity = "0.88"; }}
                    onMouseLeave={e => e.currentTarget.style.opacity = "1"}
                  >
                    <IconCheck color={checked.size === 0 ? C.textMuted : "white"} />
                    Confirm Selected{checked.size > 0 ? ` (${checked.size})` : ""}
                  </button>
                </div>

                {/* Review rows */}
                <div style={{ background: C.bg, border: `1px solid ${C.amberBorder}`, borderRadius: 8, overflow: "hidden" }}>
                  {review.map((m, i) => (
                    <div key={m.id} style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "9px 14px",
                      background: checked.has(m.id) ? C.amberLight : (i % 2 === 1 ? C.bgMuted : C.bg),
                      borderBottom: i < review.length - 1 ? `1px solid ${C.border}` : "none",
                      transition: "background 0.1s",
                    }}>
                      <input type="checkbox" checked={checked.has(m.id)} onChange={() => toggleCheck(m.id)}
                        style={{ width: 14, height: 14, accentColor: C.red, cursor: "pointer", flexShrink: 0 }} />
                      <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono','Fira Code',monospace", color: C.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.apiField}
                      </span>
                      <div style={{ flexShrink: 0 }}><IconArrowRight /></div>
                      <select value={m.ucpField || ""} onChange={e => changeUcp(m.id, e.target.value)}
                        style={{
                          fontSize: 12, fontFamily: "'JetBrains Mono','Fira Code',monospace",
                          fontWeight: 600, color: C.red, background: C.redLight,
                          border: `1px solid ${C.redBorder}`, borderRadius: 5,
                          padding: "4px 6px", cursor: "pointer", outline: "none",
                          maxWidth: 185, flexShrink: 0,
                        }}>
                        <option value="">— select —</option>
                        {ALL_UCP_FIELDS.map(f => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── AUTO-MAPPED ── */}
            {auto.length > 0 && (
              <section>
                <SectionHeader dot="green" label="Auto-Mapped" count={auto.length} />
                <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
                  {auto.map((m, i) => (
                    <div key={m.id} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "8px 14px",
                      background: i % 2 === 1 ? C.bgMuted : C.bg,
                      borderBottom: i < auto.length - 1 ? `1px solid ${C.border}` : "none",
                    }}>
                      <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono','Fira Code',monospace", color: C.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.apiField}
                      </span>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        <IconArrowRight />
                        <IconCheck color={C.green} />
                        <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono','Fira Code',monospace", color: C.text }}>{m.ucpField}</span>
                        <button onClick={() => setEditId(m.id)}
                          style={{
                            fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 5,
                            border: `1px solid ${C.border}`, background: C.bg, color: C.textSub,
                            cursor: "pointer", fontFamily: "inherit", marginLeft: 4,
                          }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = C.red; e.currentTarget.style.color = C.red; e.currentTarget.style.background = C.redLight; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textSub; e.currentTarget.style.background = C.bg; }}
                        >Edit</button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── UNMAPPED REQUIRED ── */}
            {unmapped.length > 0 && (
              <section>
                <SectionHeader dot="red" label="Unmapped Required" count={unmapped.length} />
                <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
                  {unmapped.map((m, i) => (
                    <div key={m.id} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "8px 14px", gap: 10,
                      borderBottom: i < unmapped.length - 1 ? `1px solid ${C.border}` : "none",
                    }}>
                      <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono','Fira Code',monospace", color: C.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.apiField}<span style={{ color: C.red }}>*</span>
                        {" "}<span style={{ color: C.textMuted, fontSize: 11 }}>({m.apiType})</span>
                      </span>
                      <select value="" onChange={e => { if (e.target.value) changeUcp(m.id, e.target.value, "auto"); }}
                        style={{
                          fontSize: 12, fontFamily: "'JetBrains Mono','Fira Code',monospace",
                          fontWeight: 600, color: C.red, background: C.redLight,
                          border: `1px solid ${C.redBorder}`, borderRadius: 5,
                          padding: "4px 6px", cursor: "pointer", outline: "none",
                          maxWidth: 200, flexShrink: 0,
                        }}>
                        <option value="">— map to UCP field —</option>
                        {ALL_UCP_FIELDS.map(f => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </section>
            )}

          </div>
        )}
      </div>
    </div>
  );
}

// ─── RIGHT PANEL ──────────────────────────────────────────────────────────────
function RightPanel({ parsedSpec }) {
  const [search, setSearch]         = useState("");
  const [openGroups, setOpenGroups] = useState({});

  useEffect(() => {
    if (parsedSpec?.endpoints?.length)
      setOpenGroups({ [parsedSpec.endpoints[0].label]: true });
  }, [parsedSpec]);

  const toggle = label => setOpenGroups(p => ({ ...p, [label]: !p[label] }));

  return (
    <div style={{
      width: 260, minWidth: 260, display: "flex", flexDirection: "column",
      borderLeft: `1px solid ${C.border}`, background: C.bg, overflow: "hidden",
    }}>
      {/* Panel header */}
      <div style={{ padding: "12px 16px 10px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
          </svg>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Endpoints (API)</span>
        </div>
        <SearchInput value={search} onChange={setSearch} placeholder="Search API fields…" />
      </div>

      {/* Endpoint list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {!parsedSpec ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 80 }}>
            <p style={{ fontSize: 12, color: C.textMuted, textAlign: "center", padding: "0 20px" }}>
              Upload a Swagger file to see endpoints
            </p>
          </div>
        ) : parsedSpec.endpoints.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 80 }}>
            <p style={{ fontSize: 12, color: C.textMuted, textAlign: "center", padding: "0 20px" }}>
              No endpoints found in this spec
            </p>
          </div>
        ) : (
          parsedSpec.endpoints.map(ep => {
            const isOpen = openGroups[ep.label];
            const isGet  = ep.method === "GET";
            const filtered = ep.fields.filter(f =>
              !search || f.name.toLowerCase().includes(search.toLowerCase())
            );
            return (
              <div key={ep.label} style={{ borderBottom: `1px solid ${C.border}` }}>
                <button onClick={() => toggle(ep.label)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 7,
                    padding: "9px 12px", background: "none", border: "none",
                    cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = C.bgMuted}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}
                >
                  <span style={{ color: C.textMuted }}><IconChevron open={isOpen} /></span>
                  <span style={{
                    fontSize: 10.5, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                    flexShrink: 0,
                    background: isGet ? "#DCFCE7" : C.redLight,
                    color:      isGet ? "#15803D" : C.red,
                  }}>
                    {ep.method}
                  </span>
                  <span style={{ fontSize: 11.5, fontFamily: "'JetBrains Mono','Fira Code',monospace", color: C.textSub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {ep.path}
                  </span>
                </button>

                {isOpen && (
                  <div style={{ paddingBottom: 4 }}>
                    {filtered.length === 0 ? (
                      <p style={{ fontSize: 11, color: C.textMuted, padding: "4px 30px" }}>No matching fields</p>
                    ) : filtered.map(f => (
                      <div key={f.name}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "5px 12px 5px 28px",
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = C.bgMuted}
                        onMouseLeave={e => e.currentTarget.style.background = "none"}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                          <span style={{ fontSize: 11.5, fontFamily: "'JetBrains Mono','Fira Code',monospace", color: C.textSub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {f.name}
                          </span>
                          <span style={{
                            fontSize: 10, padding: "1px 4px", borderRadius: 3,
                            background: "#F3F4F6", color: C.textMuted,
                            fontFamily: "'JetBrains Mono','Fira Code',monospace", flexShrink: 0,
                          }}>
                            {f.type}
                          </span>
                        </div>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, flexShrink: 0, marginLeft: 6 }} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function UCPGatewayPortal() {
  const [parsedSpec,  setParsedSpec]  = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [mappings,    setMappings]    = useState(null);
  const [generating,  setGenerating]  = useState(false);
  const [ucpVersion,  setUcpVersion]  = useState("UCP v2.4");

  const handleFileLoaded = useCallback((spec, _name, err) => {
    setParsedSpec(spec);
    setUploadError(err || null);
    setMappings(null);
  }, []);

  const handleGenerate = useCallback(() => {
    if (!parsedSpec?.endpoints?.length) return;
    setGenerating(true);
    setTimeout(() => {
      setMappings(generateMappings(parsedSpec));
      setGenerating(false);
    }, 900 + Math.random() * 500);
  }, [parsedSpec]);

  const canGenerate = !!parsedSpec && parsedSpec.endpoints.length > 0 && !mappings && !generating;

  return (
    <div style={{
      height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden",
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      background: C.bg, color: C.text,
    }}>
      <Navbar
        parsedSpec={parsedSpec}
        uploadError={uploadError}
        onFileLoaded={handleFileLoaded}
        onGenerate={handleGenerate}
        generating={generating}
        canGenerate={canGenerate}
        ucpVersion={ucpVersion}
        setUcpVersion={setUcpVersion}
      />
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <LeftPanel />
        <CenterPanel mappings={mappings} setMappings={setMappings} hasMapping={!!mappings} />
        <RightPanel parsedSpec={parsedSpec} />
      </div>
    </div>
  );
}
