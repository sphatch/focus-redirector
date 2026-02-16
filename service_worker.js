const STORAGE_KEY = "redirect_rules";
const DNR_RULE_MAP_KEY = "redirect_dnr_rule_map";
const METRICS_KEY = "redirect_metrics";
let metricsUpdateQueue = Promise.resolve();

function getStorageArea() {
  return chrome.storage.sync || chrome.storage.local;
}

function storageGet(key) {
  return new Promise((resolve) => {
    getStorageArea().get([key], (result) => {
      if (chrome.runtime.lastError) {
        console.error("storage get failed:", chrome.runtime.lastError.message);
        resolve({});
        return;
      }
      resolve(result || {});
    });
  });
}

function localStorageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        console.error("local storage get failed:", chrome.runtime.lastError.message);
        resolve({});
        return;
      }
      resolve(result || {});
    });
  });
}

function localStorageSet(payload) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(payload, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateHostname(hostname) {
  if (typeof hostname !== "string") {
    return { valid: false, error: "Hostname is required." };
  }

  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    return { valid: false, error: "Hostname is required." };
  }

  if (normalized.includes("/") || normalized.includes(" ") || normalized.includes(":") || normalized.includes("?")) {
    return { valid: false, error: "Hostname must not include scheme, path, spaces, or query." };
  }

  const parts = normalized.split(".");
  if (parts.length < 2) {
    return { valid: false, error: "Hostname must include at least one dot." };
  }

  for (const label of parts) {
    if (!label) {
      return { valid: false, error: "Hostname labels cannot be empty." };
    }
    if (!/^[a-z0-9-]+$/.test(label)) {
      return { valid: false, error: "Hostname can only use letters, numbers, dots, and hyphens." };
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return { valid: false, error: "Hostname labels cannot start or end with hyphen." };
    }
  }

  return { valid: true, value: normalized };
}

function validateTargetUrl(urlValue) {
  if (typeof urlValue !== "string") {
    return { valid: false, error: "Target URL is required." };
  }

  const trimmed = urlValue.trim();
  if (!trimmed) {
    return { valid: false, error: "Target URL is required." };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: "Target URL must be a valid absolute URL." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, error: "Target URL must start with http:// or https://." };
  }

  return { valid: true, value: parsed.toString(), hostname: parsed.hostname.toLowerCase() };
}

function validateRule(rule) {
  if (!rule || typeof rule !== "object") {
    return { valid: false, error: "Invalid rule object." };
  }

  const hostResult = validateHostname(rule.source_hostname || "");
  if (!hostResult.valid) {
    return { valid: false, error: hostResult.error };
  }

  const targetResult = validateTargetUrl(rule.target_url || "");
  if (!targetResult.valid) {
    return { valid: false, error: targetResult.error };
  }

  if (targetResult.hostname === hostResult.value) {
    return { valid: false, error: "Target URL hostname cannot match source hostname (self-loop)." };
  }

  return {
    valid: true,
    normalizedRule: {
      id: String(rule.id || ""),
      enabled: Boolean(rule.enabled),
      source_hostname: hostResult.value,
      target_url: targetResult.value
    }
  };
}

function hashStringToRuleId(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0) & 0x7fffffff;
}

function makeStableDnrId(rule, usedIds) {
  const seed = `${rule.id}|${rule.source_hostname}|${rule.target_url}`;
  let candidate = (hashStringToRuleId(seed) % 1000000000) + 1;
  while (usedIds.has(candidate)) {
    candidate += 1;
    if (candidate > 2147483647) {
      candidate = 1;
    }
  }
  usedIds.add(candidate);
  return candidate;
}

async function getStoredRules() {
  const result = await storageGet(STORAGE_KEY);
  const rawRules = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];

  const normalized = [];
  for (const rawRule of rawRules) {
    const checked = validateRule(rawRule);
    if (checked.valid) {
      normalized.push(checked.normalizedRule);
    } else {
      console.warn("Skipping invalid stored rule:", checked.error, rawRule);
    }
  }

  return normalized;
}

async function syncDynamicRules() {
  const rules = await getStoredRules();

  const enabledRules = rules.filter((rule) => rule.enabled);
  const usedIds = new Set();

  const dnrRuleMap = {};
  const dnrRules = enabledRules.map((rule) => {
    const escapedHost = escapeRegex(rule.source_hostname);
    const dnrId = makeStableDnrId(rule, usedIds);
    dnrRuleMap[String(dnrId)] = rule.id;
    return {
      id: dnrId,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          url: rule.target_url
        }
      },
      condition: {
        regexFilter: `^https?://([a-z0-9-]+\\.)*${escapedHost}(?::\\d+)?(?:/|$).*`,
        resourceTypes: ["main_frame"]
      }
    };
  });

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: dnrRules
  });

  await localStorageSet({ [DNR_RULE_MAP_KEY]: dnrRuleMap });
}

function queueMetricIncrement(ruleId) {
  metricsUpdateQueue = metricsUpdateQueue
    .then(async () => {
      const stored = await localStorageGet([METRICS_KEY]);
      const metrics = stored[METRICS_KEY] && typeof stored[METRICS_KEY] === "object"
        ? stored[METRICS_KEY]
        : {};

      const currentTotal = Number.isFinite(metrics.total_redirects) ? metrics.total_redirects : 0;
      const perRule = metrics.per_rule && typeof metrics.per_rule === "object" ? metrics.per_rule : {};

      const nextMetrics = {
        total_redirects: currentTotal + 1,
        per_rule: { ...perRule }
      };

      if (ruleId) {
        const currentRuleCount = Number.isFinite(nextMetrics.per_rule[ruleId]) ? nextMetrics.per_rule[ruleId] : 0;
        nextMetrics.per_rule[ruleId] = currentRuleCount + 1;
      }

      await localStorageSet({ [METRICS_KEY]: nextMetrics });
    })
    .catch((error) => {
      console.error("Failed to increment redirect metrics:", error);
    });
}

function extractMatchedDynamicRuleId(details) {
  const candidates = [
    details?.rule?.ruleId,
    details?.matchedRule?.ruleId,
    details?.ruleId
  ];

  for (const value of candidates) {
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return null;
}

chrome.runtime.onInstalled.addListener(() => {
  syncDynamicRules().catch((error) => {
    console.error("Failed to sync rules on install:", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  syncDynamicRules().catch((error) => {
    console.error("Failed to sync rules on startup:", error);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  const usingSync = Boolean(chrome.storage.sync);
  if ((usingSync && areaName !== "sync") || (!usingSync && areaName !== "local")) {
    return;
  }

  if (!changes[STORAGE_KEY]) {
    return;
  }

  syncDynamicRules().catch((error) => {
    console.error("Failed to sync rules after storage update:", error);
  });
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (details) => {
    const dnrRuleId = extractMatchedDynamicRuleId(details);
    if (!dnrRuleId) {
      queueMetricIncrement(null);
      return;
    }

    const result = await localStorageGet([DNR_RULE_MAP_KEY]);
    const dnrRuleMap = result[DNR_RULE_MAP_KEY] && typeof result[DNR_RULE_MAP_KEY] === "object"
      ? result[DNR_RULE_MAP_KEY]
      : {};
    const internalRuleId = typeof dnrRuleMap[String(dnrRuleId)] === "string"
      ? dnrRuleMap[String(dnrRuleId)]
      : null;
    queueMetricIncrement(internalRuleId);
  });
}
