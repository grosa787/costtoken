use chrono::{DateTime, Local, TimeZone};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub buckets: Vec<UsageBucket>,
    pub sources: Vec<SourceStatus>,
    pub scanned_at: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub hour: i64,
    pub provider: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_write1h_tokens: u64,
    pub reasoning_output_tokens: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub id: String,
    pub name: String,
    pub status: String,
    pub file_count: u64,
    pub event_count: u64,
    pub detail: String,
}

#[derive(Clone, Debug, Default)]
struct Counters {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    cache_write1h_tokens: u64,
    reasoning_output_tokens: u64,
}

impl Counters {
    fn add(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cache_write_tokens = self
            .cache_write_tokens
            .saturating_add(other.cache_write_tokens);
        self.cache_write1h_tokens = self
            .cache_write1h_tokens
            .saturating_add(other.cache_write1h_tokens);
        self.reasoning_output_tokens = self
            .reasoning_output_tokens
            .saturating_add(other.reasoning_output_tokens);
    }

    fn total(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_write_tokens)
    }

    fn take_category_max(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.max(other.input_tokens);
        self.output_tokens = self.output_tokens.max(other.output_tokens);
        self.cache_read_tokens = self.cache_read_tokens.max(other.cache_read_tokens);
        self.cache_write_tokens = self.cache_write_tokens.max(other.cache_write_tokens);
        self.cache_write1h_tokens = self.cache_write1h_tokens.max(other.cache_write1h_tokens);
        self.reasoning_output_tokens = self
            .reasoning_output_tokens
            .max(other.reasoning_output_tokens);
    }
}

#[derive(Clone, Debug)]
struct UsageEvent {
    hour: i64,
    model: String,
    counters: Counters,
}

#[derive(Clone, Debug, Default)]
struct FileSummary {
    buckets: BTreeMap<(i64, String), Counters>,
    event_count: u64,
    skipped_records: u64,
}

impl FileSummary {
    fn add_event(&mut self, mut event: UsageEvent) {
        event.counters.output_tokens = event
            .counters
            .output_tokens
            .max(event.counters.reasoning_output_tokens);
        event.counters.cache_write_tokens = event
            .counters
            .cache_write_tokens
            .max(event.counters.cache_write1h_tokens);
        if event.counters.total() == 0 && event.counters.reasoning_output_tokens == 0 {
            return;
        }
        self.buckets
            .entry((event.hour, event.model))
            .or_default()
            .add(&event.counters);
        self.event_count = self.event_count.saturating_add(1);
    }
}

#[derive(Clone)]
struct CachedFile {
    len: u64,
    modified_ns: u128,
    summary: FileSummary,
}

static FILE_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedFile>>> = OnceLock::new();

#[derive(Clone)]
struct CachedOpenCodeRow {
    version: i64,
    message_key: u64,
    event: Option<UsageEvent>,
    skipped: bool,
}

#[derive(Clone, Default)]
struct OpenCodeRowCache {
    rows: HashMap<i64, CachedOpenCodeRow>,
}

static OPENCODE_ROW_CACHE: OnceLock<Mutex<HashMap<PathBuf, OpenCodeRowCache>>> = OnceLock::new();

type AggregateKey = (i64, String, String);

#[tauri::command]
pub async fn scan_usage() -> Result<ScanReport, String> {
    tauri::async_runtime::spawn_blocking(scan_usage_sync)
        .await
        .map_err(|error| format!("Usage scan worker failed: {error}"))?
}

fn scan_usage_sync() -> Result<ScanReport, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Cannot locate the current user's home directory".to_string())?;

    let mut aggregate = BTreeMap::<AggregateKey, Counters>::new();
    let mut sources = Vec::new();

    let claude_root = home.join(".claude/projects");
    let claude_files = discover_jsonl(&claude_root, None);
    sources.push(scan_source(
        "claude",
        "Claude Code",
        claude_root.exists(),
        claude_files,
        parse_claude_file,
        &mut aggregate,
    ));

    let codex_root = home.join(".codex");
    let mut codex_files = discover_jsonl(&codex_root.join("sessions"), None);
    codex_files.extend(discover_jsonl(
        &codex_root.join("archived_sessions"),
        Some(1),
    ));
    codex_files.sort();
    let mut codex_rollouts = BTreeMap::new();
    for path in codex_files {
        codex_rollouts
            .entry(codex_rollout_key(&path))
            .or_insert(path);
    }
    let codex_files = codex_rollouts.into_values().collect();
    sources.push(scan_source(
        "codex",
        "Codex",
        codex_root.exists(),
        codex_files,
        parse_codex_file,
        &mut aggregate,
    ));

    let gemini_root = home.join(".gemini");
    let gemini_files = discover_gemini_files(&gemini_root.join("tmp"));
    sources.push(scan_source(
        "gemini",
        "Gemini CLI",
        gemini_root.exists(),
        gemini_files,
        parse_gemini_file,
        &mut aggregate,
    ));

    let grok_root = home.join(".grok");
    let grok_log = grok_root.join("logs/unified.jsonl");
    let grok_files = if grok_log.is_file() {
        vec![grok_log]
    } else {
        Vec::new()
    };
    sources.push(scan_source(
        "grok",
        "Grok",
        grok_root.exists(),
        grok_files,
        parse_grok_file,
        &mut aggregate,
    ));

    let app_support = home.join("Library/Application Support");
    let antigravity_paths = [
        home.join(".gemini/antigravity"),
        home.join(".antigravity"),
        app_support.join("Antigravity"),
        app_support.join("Antigravity IDE"),
    ];
    let antigravity_detected = antigravity_paths.iter().any(|path| path.exists());
    let antigravity_file_count = count_direct_files(
        &home.join(".gemini/antigravity/conversations"),
        &["db", "pb"],
    );
    sources.push(unsupported_status(
        "antigravity",
        "Antigravity",
        antigravity_detected,
        antigravity_file_count,
        "Данные найдены, но счётчики токенов хранятся в версионируемых protobuf-блоках.",
    ));

    let opencode_root = home.join(".local/share/opencode");
    let opencode_db = opencode_root.join("opencode.db");
    let opencode_files = if opencode_db.is_file() {
        vec![opencode_db]
    } else {
        Vec::new()
    };
    sources.push(scan_source(
        "opencode",
        "OpenCode",
        opencode_root.exists(),
        opencode_files,
        parse_opencode_file,
        &mut aggregate,
    ));

    let localcode_root = home.join(".localcode");
    let localcode_db = localcode_root.join("sessions.db");
    let localcode_files = if localcode_db.is_file() {
        vec![localcode_db]
    } else {
        Vec::new()
    };
    sources.push(scan_source(
        "localcode",
        "LocalCode",
        localcode_root.exists(),
        localcode_files,
        parse_localcode_file,
        &mut aggregate,
    ));

    let cursor_paths = [home.join(".cursor"), app_support.join("Cursor")];
    let cursor_detected = cursor_paths.iter().any(|path| path.exists());
    let cursor_evidence = [
        home.join(".cursor/ai-tracking/ai-code-tracking.db"),
        app_support.join("Cursor/User/globalStorage/state.vscdb"),
    ];
    let cursor_file_count = cursor_evidence.iter().filter(|path| path.is_file()).count() as u64;
    sources.push(unsupported_status(
        "cursor",
        "Cursor",
        cursor_detected,
        cursor_file_count,
        "Локальные данные найдены, но надёжные счётчики токенов недоступны.",
    ));

    let buckets = aggregate
        .into_iter()
        .map(|((hour, provider, model), counters)| UsageBucket {
            hour,
            provider,
            model,
            input_tokens: counters.input_tokens,
            output_tokens: counters.output_tokens,
            cache_read_tokens: counters.cache_read_tokens,
            cache_write_tokens: counters.cache_write_tokens,
            cache_write1h_tokens: counters.cache_write1h_tokens,
            reasoning_output_tokens: counters.reasoning_output_tokens,
        })
        .collect();

    Ok(ScanReport {
        buckets,
        sources,
        scanned_at: chrono::Utc::now().timestamp(),
    })
}

fn scan_source(
    id: &str,
    name: &str,
    detected: bool,
    files: Vec<PathBuf>,
    parser: fn(&Path) -> Result<FileSummary, String>,
    aggregate: &mut BTreeMap<AggregateKey, Counters>,
) -> SourceStatus {
    if !detected {
        return absent_status(id, name);
    }

    let file_count = files.len() as u64;
    let mut event_count = 0_u64;
    let mut skipped_records = 0_u64;
    let mut failed_files = 0_u64;

    for path in files {
        match cached_summary(&path, parser) {
            Ok(summary) => {
                event_count = event_count.saturating_add(summary.event_count);
                skipped_records = skipped_records.saturating_add(summary.skipped_records);
                for ((hour, model), counters) in summary.buckets {
                    aggregate
                        .entry((hour, id.to_string(), model))
                        .or_default()
                        .add(&counters);
                }
            }
            Err(_) => failed_files = failed_files.saturating_add(1),
        }
    }

    build_source_status(
        id,
        name,
        file_count,
        event_count,
        skipped_records,
        failed_files,
    )
}

fn build_source_status(
    id: &str,
    name: &str,
    file_count: u64,
    event_count: u64,
    skipped_records: u64,
    failed_files: u64,
) -> SourceStatus {
    let has_errors = failed_files > 0 || skipped_records > 0;
    let detail = if file_count == 0 {
        "Папка агента найдена, совместимых журналов пока нет.".to_string()
    } else if event_count == 0 && !has_errors {
        "Совместимые журналы найдены, но надёжные счётчики токенов не обнаружены.".to_string()
    } else if has_errors {
        format!(
            "Считано записей: {event_count}; пропущено повреждённых записей: {skipped_records}; недоступных файлов: {failed_files}."
        )
    } else {
        format!("Считано записей: {event_count}; файлов: {file_count}.")
    };

    SourceStatus {
        id: id.to_string(),
        name: name.to_string(),
        status: if file_count == 0 {
            "unsupported"
        } else if event_count == 0 && has_errors {
            "error"
        } else if event_count == 0 {
            "unsupported"
        } else {
            "ready"
        }
        .into(),
        file_count,
        event_count,
        detail,
    }
}

fn cached_summary(
    path: &Path,
    parser: fn(&Path) -> Result<FileSummary, String>,
) -> Result<FileSummary, String> {
    let (len, modified_ns) = file_signature(path)?;

    let cache = FILE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(entry) = guard.get(path) {
            if entry.len == len && entry.modified_ns == modified_ns {
                return Ok(entry.summary.clone());
            }
        }
    }

    let summary = parser(path)?;
    if let Ok(mut guard) = cache.lock() {
        guard.insert(
            path.to_path_buf(),
            CachedFile {
                len,
                modified_ns,
                summary: summary.clone(),
            },
        );
    }
    Ok(summary)
}

fn file_signature(path: &Path) -> Result<(u64, u128), String> {
    let mut candidates = vec![path.to_path_buf()];
    if path.extension().and_then(|extension| extension.to_str()) == Some("db") {
        for suffix in ["-wal", "-shm"] {
            let mut sidecar = path.as_os_str().to_os_string();
            sidecar.push(suffix);
            candidates.push(PathBuf::from(sidecar));
        }
    }

    let mut total_len = 0_u64;
    let mut newest_modified = 0_u128;
    let mut found_primary = false;
    for (index, candidate) in candidates.into_iter().enumerate() {
        let metadata = match fs::metadata(candidate) {
            Ok(metadata) => metadata,
            Err(_) if index > 0 => continue,
            Err(_) => return Err("Usage file metadata is unavailable".to_string()),
        };
        found_primary |= index == 0;
        total_len = total_len.saturating_add(metadata.len());
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        newest_modified = newest_modified.max(modified);
    }
    if found_primary {
        Ok((total_len, newest_modified))
    } else {
        Err("Usage file metadata is unavailable".to_string())
    }
}

fn parse_claude_file(path: &Path) -> Result<FileSummary, String> {
    let reader = BufReader::new(
        File::open(path).map_err(|_| "Claude usage file could not be opened".to_string())?,
    );
    parse_claude_reader(reader)
}

fn parse_claude_reader<R: BufRead>(reader: R) -> Result<FileSummary, String> {
    let mut summary = FileSummary::default();
    let mut aliases = HashMap::<String, String>::new();
    let mut events = HashMap::<String, UsageEvent>::new();
    let mut idless = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else {
            summary.skipped_records += 1;
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        if !line.contains("\"usage\"") || !line.contains("assistant") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            summary.skipped_records += 1;
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("assistant")
            && value.pointer("/message/role").and_then(Value::as_str) != Some("assistant")
        {
            continue;
        }
        let Some(usage) = value
            .pointer("/message/usage")
            .or_else(|| value.get("usage"))
        else {
            continue;
        };
        let Some(hour) = value.get("timestamp").and_then(timestamp_hour) else {
            summary.skipped_records += 1;
            continue;
        };

        let one_hour = token(usage.pointer("/cache_creation/ephemeral_1h_input_tokens"));
        let five_minute = token(usage.pointer("/cache_creation/ephemeral_5m_input_tokens"));
        let reported_write = token(usage.get("cache_creation_input_tokens"));
        let total_write = reported_write.max(one_hour.saturating_add(five_minute));
        let event = UsageEvent {
            hour,
            model: string_at(&value, &["/message/model", "/model", "/modelId"]),
            counters: Counters {
                input_tokens: token(usage.get("input_tokens")),
                output_tokens: token(usage.get("output_tokens")),
                cache_read_tokens: token(usage.get("cache_read_input_tokens")),
                cache_write_tokens: total_write,
                cache_write1h_tokens: one_hour,
                reasoning_output_tokens: token(
                    usage.pointer("/output_tokens_details/thinking_tokens"),
                ),
            },
        };

        let ids: Vec<String> = [
            value.pointer("/message/id").and_then(Value::as_str),
            value.get("requestId").and_then(Value::as_str),
        ]
        .into_iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect();
        if !ids.is_empty() {
            let canonical = ids
                .iter()
                .find_map(|id| aliases.get(id).cloned())
                .unwrap_or_else(|| ids[0].clone());
            if let Some(previous) = events.get_mut(&canonical) {
                previous.counters.take_category_max(&event.counters);
                if previous.model == "unknown" && event.model != "unknown" {
                    previous.model = event.model;
                }
                previous.hour = event.hour;
            } else {
                events.insert(canonical.clone(), event);
            }
            for id in ids {
                aliases.insert(id, canonical.clone());
            }
        } else {
            idless.push(event);
        }
    }

    for event in events.into_values().chain(idless) {
        summary.add_event(event);
    }
    Ok(summary)
}

fn parse_codex_file(path: &Path) -> Result<FileSummary, String> {
    let reader = BufReader::new(
        File::open(path).map_err(|_| "Codex usage file could not be opened".to_string())?,
    );
    parse_codex_reader(reader)
}

fn parse_codex_reader<R: BufRead>(reader: R) -> Result<FileSummary, String> {
    let mut summary = FileSummary::default();
    let mut model = "unknown".to_string();
    let mut primary = HashMap::<String, UsageEvent>::new();
    let mut primary_idless = Vec::new();
    let mut fallback = Vec::new();
    let mut fallback_total = None::<CodexUsage>;

    for line in reader.lines() {
        let Ok(line) = line else {
            summary.skipped_records += 1;
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        if !line.contains("token_usage_record")
            && !line.contains("token_count")
            && !line.contains("turn_context")
        {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            summary.skipped_records += 1;
            continue;
        };
        let record_type = value.get("type").and_then(Value::as_str);
        let payload_type = value.pointer("/payload/type").and_then(Value::as_str);

        if record_type == Some("turn_context") {
            if let Some(next_model) = value.pointer("/payload/model").and_then(Value::as_str) {
                model = next_model.to_string();
            }
            continue;
        }

        let Some(hour) = value.get("timestamp").and_then(timestamp_hour) else {
            continue;
        };

        if record_type == Some("token_usage_record") {
            if let Some(usage) = value.pointer("/payload/usage") {
                let event = codex_event(hour, model.clone(), usage);
                let key = value
                    .pointer("/payload/response_id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned);
                if let Some(key) = key {
                    primary.entry(key).or_insert(event);
                } else {
                    primary_idless.push(event);
                }
            }
        } else if record_type == Some("event_msg") && payload_type == Some("token_count") {
            if let Some(usage) = value.pointer("/payload/info/total_token_usage") {
                let current = CodexUsage::from_value(usage);
                let delta = current.delta_from(fallback_total.as_ref());
                fallback_total = Some(current);
                if !delta.is_zero() {
                    fallback.push(delta.into_event(hour, model.clone()));
                }
            }
        }
    }

    let events: Box<dyn Iterator<Item = UsageEvent>> =
        if primary.is_empty() && primary_idless.is_empty() {
            Box::new(fallback.into_iter())
        } else {
            Box::new(primary.into_values().chain(primary_idless))
        };
    for event in events {
        summary.add_event(event);
    }
    Ok(summary)
}

#[derive(Clone, Debug, Default)]
struct CodexUsage {
    input: u64,
    cache_read: u64,
    cache_write: u64,
    output: u64,
    reasoning: u64,
    total: u64,
}

impl CodexUsage {
    fn from_value(usage: &Value) -> Self {
        Self {
            input: token(usage.get("input_tokens")),
            cache_read: token(usage.get("cached_input_tokens")),
            cache_write: token(usage.get("cache_write_input_tokens")),
            output: token(usage.get("output_tokens")),
            reasoning: token(usage.get("reasoning_output_tokens")),
            total: token(usage.get("total_tokens")),
        }
    }

    fn delta_from(&self, previous: Option<&Self>) -> Self {
        let Some(previous) = previous else {
            return self.clone();
        };
        if self.total < previous.total {
            return self.clone();
        }
        Self {
            input: self.input.saturating_sub(previous.input),
            cache_read: self.cache_read.saturating_sub(previous.cache_read),
            cache_write: self.cache_write.saturating_sub(previous.cache_write),
            output: self.output.saturating_sub(previous.output),
            reasoning: self.reasoning.saturating_sub(previous.reasoning),
            total: self.total.saturating_sub(previous.total),
        }
    }

    fn is_zero(&self) -> bool {
        self.input == 0
            && self.cache_read == 0
            && self.cache_write == 0
            && self.output == 0
            && self.reasoning == 0
    }

    fn into_event(self, hour: i64, model: String) -> UsageEvent {
        UsageEvent {
            hour,
            model,
            counters: Counters {
                input_tokens: self
                    .input
                    .saturating_sub(self.cache_read)
                    .saturating_sub(self.cache_write),
                output_tokens: self.output,
                cache_read_tokens: self.cache_read,
                cache_write_tokens: self.cache_write,
                cache_write1h_tokens: 0,
                reasoning_output_tokens: self.reasoning,
            },
        }
    }
}

fn codex_event(hour: i64, model: String, usage: &Value) -> UsageEvent {
    let cache_read = token(usage.get("cached_input_tokens"));
    let cache_write = token(usage.get("cache_write_input_tokens"));
    let raw_input = token(usage.get("input_tokens"));
    UsageEvent {
        hour,
        model,
        counters: Counters {
            input_tokens: raw_input
                .saturating_sub(cache_read)
                .saturating_sub(cache_write),
            output_tokens: token(usage.get("output_tokens")),
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_write,
            cache_write1h_tokens: 0,
            reasoning_output_tokens: token(usage.get("reasoning_output_tokens")),
        },
    }
}

fn parse_gemini_file(path: &Path) -> Result<FileSummary, String> {
    let reader = BufReader::new(
        File::open(path).map_err(|_| "Gemini usage file could not be opened".to_string())?,
    );
    if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
        parse_gemini_jsonl_reader(reader)
    } else {
        parse_gemini_reader(reader)
    }
}

fn parse_gemini_reader<R: std::io::Read>(reader: R) -> Result<FileSummary, String> {
    let value: Value = serde_json::from_reader(reader)
        .map_err(|_| "Gemini usage file contains invalid JSON".to_string())?;
    let mut summary = FileSummary::default();
    let session_time = value
        .get("startTime")
        .and_then(timestamp_hour)
        .or_else(|| value.get("lastUpdated").and_then(timestamp_hour));
    let mut events = HashMap::<String, UsageEvent>::new();
    let mut idless = Vec::new();

    let Some(messages) = value.get("messages").and_then(Value::as_array) else {
        return Ok(summary);
    };
    for message in messages {
        match gemini_event(message, session_time, None) {
            Some(event) => {
                if let Some(id) = message
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    events.insert(id.to_string(), event);
                } else {
                    idless.push(event);
                }
            }
            None if message.get("tokens").is_some() => summary.skipped_records += 1,
            None => {}
        }
    }
    for event in events.into_values().chain(idless) {
        summary.add_event(event);
    }
    Ok(summary)
}

fn parse_gemini_jsonl_reader<R: BufRead>(reader: R) -> Result<FileSummary, String> {
    let mut summary = FileSummary::default();
    let mut session_time = None;
    let mut events = HashMap::<String, UsageEvent>::new();
    let mut idless = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else {
            summary.skipped_records += 1;
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            summary.skipped_records += 1;
            continue;
        };
        if let Some(update) = value.get("$set") {
            session_time = update
                .get("startTime")
                .and_then(timestamp_hour)
                .or(session_time);
            if let Some(messages) = update.get("messages").and_then(Value::as_array) {
                events.clear();
                idless.clear();
                for message in messages {
                    replay_gemini_message(message, session_time, &mut events, &mut idless);
                }
            }
            continue;
        }
        if value.get("sessionId").is_some() && value.get("id").is_none() {
            session_time = value
                .get("startTime")
                .and_then(timestamp_hour)
                .or_else(|| value.get("lastUpdated").and_then(timestamp_hour))
                .or(session_time);
            continue;
        }
        replay_gemini_message(&value, session_time, &mut events, &mut idless);
    }

    for event in events.into_values().chain(idless) {
        summary.add_event(event);
    }
    Ok(summary)
}

fn replay_gemini_message(
    message: &Value,
    session_time: Option<i64>,
    events: &mut HashMap<String, UsageEvent>,
    idless: &mut Vec<UsageEvent>,
) {
    let id = message
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    let previous = id.and_then(|id| events.get(id));
    let Some(event) = gemini_event(message, session_time, previous) else {
        return;
    };
    if let Some(id) = id {
        events.insert(id.to_string(), event);
    } else {
        idless.push(event);
    }
}

fn gemini_event(
    message: &Value,
    session_time: Option<i64>,
    previous: Option<&UsageEvent>,
) -> Option<UsageEvent> {
    let tokens = message.get("tokens")?;
    let hour = message
        .get("timestamp")
        .and_then(timestamp_hour)
        .or_else(|| previous.map(|event| event.hour))
        .or(session_time)?;
    let cache_read = token(tokens.get("cached"));
    let raw_input = token(tokens.get("input"));
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
        .map(str::to_owned)
        .or_else(|| previous.map(|event| event.model.clone()))
        .unwrap_or_else(|| "unknown".to_string());
    Some(UsageEvent {
        hour,
        model,
        counters: Counters {
            input_tokens: raw_input
                .saturating_sub(cache_read)
                .saturating_add(token(tokens.get("tool"))),
            output_tokens: token(tokens.get("output"))
                .saturating_add(token(tokens.get("thoughts"))),
            cache_read_tokens: cache_read,
            cache_write_tokens: 0,
            cache_write1h_tokens: 0,
            reasoning_output_tokens: token(tokens.get("thoughts")),
        },
    })
}

fn parse_grok_file(path: &Path) -> Result<FileSummary, String> {
    let reader = BufReader::new(
        File::open(path).map_err(|_| "Grok usage log could not be opened".to_string())?,
    );
    parse_grok_reader(reader)
}

fn parse_grok_reader<R: BufRead>(reader: R) -> Result<FileSummary, String> {
    let mut summary = FileSummary::default();
    let mut seen = HashMap::<String, UsageEvent>::new();
    let mut session_models = HashMap::<String, String>::new();
    let mut process_models = HashMap::<String, String>::new();

    for line in reader.lines() {
        let Ok(line) = line else {
            summary.skipped_records += 1;
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        if !line.contains("prompt_tokens") && !line.contains("current_model_id") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            summary.skipped_records += 1;
            continue;
        };
        let sid = scalar_key(value.get("sid"));
        let pid = scalar_key(value.get("pid"));
        if let Some(found_model) = value
            .pointer("/ctx/current_model_id")
            .or_else(|| value.pointer("/ctx/model"))
            .and_then(Value::as_str)
        {
            if let Some(sid) = &sid {
                session_models.insert(sid.clone(), found_model.to_string());
            }
            if let Some(pid) = &pid {
                process_models.insert(pid.clone(), found_model.to_string());
            }
        }

        let Some(ctx) = value.get("ctx") else {
            continue;
        };
        if ctx.get("prompt_tokens").is_none()
            && ctx.get("completion_tokens").is_none()
            && ctx.get("cached_prompt_tokens").is_none()
        {
            continue;
        }
        let Some(hour) = value.get("ts").and_then(timestamp_hour) else {
            summary.skipped_records += 1;
            continue;
        };
        let cache_read = token(ctx.get("cached_prompt_tokens"));
        let prompt = token(ctx.get("prompt_tokens"));
        let event = UsageEvent {
            hour,
            model: ctx
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    sid.as_ref()
                        .and_then(|sid| session_models.get(sid))
                        .cloned()
                })
                .or_else(|| {
                    pid.as_ref()
                        .and_then(|pid| process_models.get(pid))
                        .cloned()
                })
                .unwrap_or_else(|| "unknown".to_string()),
            counters: Counters {
                input_tokens: prompt.saturating_sub(cache_read),
                output_tokens: token(ctx.get("completion_tokens")),
                cache_read_tokens: cache_read,
                cache_write_tokens: 0,
                cache_write1h_tokens: 0,
                reasoning_output_tokens: token(ctx.get("reasoning_tokens")),
            },
        };
        let key = format!(
            "{}|{}|{}|{}|{}|{}|{}",
            sid.as_deref().unwrap_or(""),
            timestamp_key(value.get("ts")),
            token(ctx.get("prompt_tokens")),
            token(ctx.get("completion_tokens")),
            token(ctx.get("cached_prompt_tokens")),
            token(ctx.get("reasoning_tokens")),
            token(ctx.get("loop_index")),
        );
        seen.entry(key).or_insert(event);
    }

    for event in seen.into_values() {
        summary.add_event(event);
    }
    Ok(summary)
}

fn scalar_key(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn parse_opencode_file(path: &Path) -> Result<FileSummary, String> {
    let connection = open_read_only_database(path, "OpenCode")?;
    let mut index_statement = connection
        .prepare("SELECT rowid, COALESCE(time_updated, time_created, 0) FROM message")
        .map_err(|_| "OpenCode message schema is unavailable".to_string())?;
    let index_rows = index_statement
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|_| "OpenCode messages could not be read".to_string())?;
    let mut index = Vec::new();
    for row in index_rows {
        index.push(row.map_err(|_| "OpenCode message index is damaged".to_string())?);
    }
    drop(index_statement);

    let cache = OPENCODE_ROW_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut row_cache = cache
        .lock()
        .ok()
        .and_then(|guard| guard.get(path).cloned())
        .unwrap_or_default();
    let current_rowids: HashSet<i64> = index.iter().map(|(rowid, _)| *rowid).collect();
    row_cache
        .rows
        .retain(|rowid, _| current_rowids.contains(rowid));

    let mut recent_rowids: Vec<i64> = current_rowids.iter().copied().collect();
    recent_rowids.sort_unstable_by(|left, right| right.cmp(left));
    let recent_rowids: HashSet<i64> = recent_rowids.into_iter().take(256).collect();
    let changed: Vec<(i64, i64)> = index
        .into_iter()
        .filter(|(rowid, version)| {
            recent_rowids.contains(rowid)
                || row_cache
                    .rows
                    .get(rowid)
                    .is_none_or(|cached| cached.version != *version)
        })
        .collect();

    let mut row_statement = connection
        .prepare("SELECT id, time_created, data FROM message WHERE rowid = ?1")
        .map_err(|_| "OpenCode message schema is unavailable".to_string())?;
    for (rowid, version) in changed {
        let result = row_statement.query_row([rowid], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        });
        let cached = match result {
            Ok((id, created_at, data)) => match parse_opencode_message(created_at, &data) {
                Ok(event) => CachedOpenCodeRow {
                    version,
                    message_key: hash_identifier(&id),
                    event,
                    skipped: false,
                },
                Err(()) => CachedOpenCodeRow {
                    version,
                    message_key: hash_identifier(&id),
                    event: None,
                    skipped: true,
                },
            },
            Err(_) => CachedOpenCodeRow {
                version,
                message_key: rowid as u64,
                event: None,
                skipped: true,
            },
        };
        row_cache.rows.insert(rowid, cached);
    }

    let mut summary = FileSummary::default();
    let mut seen = HashSet::new();
    for cached in row_cache.rows.values() {
        if cached.skipped {
            summary.skipped_records += 1;
            continue;
        }
        if !seen.insert(cached.message_key) {
            continue;
        }
        if let Some(event) = &cached.event {
            summary.add_event(event.clone());
        }
    }
    if let Ok(mut guard) = cache.lock() {
        guard.insert(path.to_path_buf(), row_cache);
    }
    Ok(summary)
}

fn parse_opencode_message(created_at: i64, data: &str) -> Result<Option<UsageEvent>, ()> {
    let value = serde_json::from_str::<Value>(data).map_err(|_| ())?;
    if value.get("role").and_then(Value::as_str) != Some("assistant") {
        return Ok(None);
    }
    let Some(tokens) = value.get("tokens") else {
        return Ok(None);
    };
    let hour = value
        .pointer("/time/completed")
        .and_then(timestamp_hour)
        .or_else(|| value.pointer("/time/created").and_then(timestamp_hour))
        .or_else(|| timestamp_hour(&Value::from(created_at)))
        .ok_or(())?;
    Ok(Some(UsageEvent {
        hour,
        model: string_at(&value, &["/model/modelID", "/modelID", "/model"]),
        counters: Counters {
            input_tokens: token(tokens.get("input")),
            output_tokens: token(tokens.get("output"))
                .saturating_add(token(tokens.get("reasoning"))),
            cache_read_tokens: token(tokens.pointer("/cache/read")),
            cache_write_tokens: token(tokens.pointer("/cache/write")),
            cache_write1h_tokens: 0,
            reasoning_output_tokens: token(tokens.get("reasoning")),
        },
    }))
}

fn hash_identifier(value: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn parse_localcode_file(path: &Path) -> Result<FileSummary, String> {
    let connection = open_read_only_database(path, "LocalCode")?;
    let mut statement = connection
        .prepare(
            "SELECT id, created_at, model, tokens_input, tokens_output, \
             cached_input_tokens, cache_creation_tokens FROM messages",
        )
        .map_err(|_| "LocalCode message schema is unavailable".to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                nonnegative_sql_token(row.get::<_, Option<i64>>(3)?),
                nonnegative_sql_token(row.get::<_, Option<i64>>(4)?),
                nonnegative_sql_token(row.get::<_, Option<i64>>(5)?),
                nonnegative_sql_token(row.get::<_, Option<i64>>(6)?),
            ))
        })
        .map_err(|_| "LocalCode messages could not be read".to_string())?;
    let mut summary = FileSummary::default();
    let mut seen = std::collections::HashSet::new();

    for row in rows {
        let Ok((id, created_at, model, raw_input, output, cache_read, cache_write)) = row else {
            summary.skipped_records += 1;
            continue;
        };
        if !seen.insert(id) {
            continue;
        }
        let Some(hour) = timestamp_hour(&Value::from(created_at)) else {
            summary.skipped_records += 1;
            continue;
        };
        summary.add_event(UsageEvent {
            hour,
            model: model
                .filter(|model| !model.is_empty())
                .unwrap_or_else(|| "unknown".into()),
            counters: Counters {
                input_tokens: raw_input.saturating_sub(cache_read),
                output_tokens: output,
                cache_read_tokens: cache_read,
                cache_write_tokens: cache_write,
                cache_write1h_tokens: 0,
                reasoning_output_tokens: 0,
            },
        });
    }
    Ok(summary)
}

fn open_read_only_database(path: &Path, source: &str) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| format!("{source} database could not be opened read-only"))
}

fn nonnegative_sql_token(value: Option<i64>) -> u64 {
    value.unwrap_or(0).max(0) as u64
}

fn timestamp_key(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn timestamp_hour(value: &Value) -> Option<i64> {
    let seconds = match value {
        Value::Number(number) => numeric_timestamp(number.as_i64()?),
        Value::String(text) => {
            if let Ok(number) = text.parse::<i64>() {
                numeric_timestamp(number)
            } else {
                DateTime::parse_from_rfc3339(text).ok()?.timestamp()
            }
        }
        _ => return None,
    };
    let offset = Local
        .timestamp_opt(seconds, 0)
        .single()
        .map(|timestamp| timestamp.offset().local_minus_utc())?;
    Some(hour_boundary_with_offset(seconds, offset))
}

fn hour_boundary_with_offset(seconds: i64, offset_seconds: i32) -> i64 {
    (seconds + i64::from(offset_seconds)).div_euclid(3600) * 3600 - i64::from(offset_seconds)
}

fn numeric_timestamp(value: i64) -> i64 {
    let magnitude = value.unsigned_abs();
    if magnitude >= 100_000_000_000_000 {
        value / 1_000_000
    } else if magnitude >= 100_000_000_000 {
        value / 1_000
    } else {
        value
    }
}

fn token(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn string_at(value: &Value, pointers: &[&str]) -> String {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn discover_jsonl(root: &Path, max_depth: Option<usize>) -> Vec<PathBuf> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut walk = WalkDir::new(root).follow_links(false);
    if let Some(depth) = max_depth {
        walk = walk.max_depth(depth);
    }
    let mut files: Vec<_> = walk
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .collect();
    files.sort();
    files
}

fn discover_gemini_files(root: &Path) -> Vec<PathBuf> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut files: Vec<_> = WalkDir::new(root)
        .max_depth(4)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                == Some("chats")
                && matches!(
                    path.extension().and_then(|ext| ext.to_str()),
                    Some("json" | "jsonl")
                )
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("session-"))
        })
        .collect();
    files.sort();
    files
}

fn codex_rollout_key(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let suffix = stem.rsplit('-').take(5).collect::<Vec<_>>();
    if suffix.len() == 5 {
        suffix.into_iter().rev().collect::<Vec<_>>().join("-")
    } else {
        stem.to_string()
    }
}

fn count_direct_files(root: &Path, extensions: &[&str]) -> u64 {
    fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extensions.contains(&extension))
        })
        .count() as u64
}

fn unsupported_status(
    id: &str,
    name: &str,
    detected: bool,
    file_count: u64,
    detail: &str,
) -> SourceStatus {
    if !detected {
        absent_status(id, name)
    } else {
        SourceStatus {
            id: id.to_string(),
            name: name.to_string(),
            status: "unsupported".into(),
            file_count,
            event_count: 0,
            detail: detail.to_string(),
        }
    }
}

fn absent_status(id: &str, name: &str) -> SourceStatus {
    SourceStatus {
        id: id.to_string(),
        name: name.to_string(),
        status: "absent".into(),
        file_count: 0,
        event_count: 0,
        detail: "Локальные данные не найдены.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::io::Cursor;

    #[test]
    fn claude_normalizes_disjoint_cache_and_deduplicates() {
        let summary =
            parse_claude_reader(Cursor::new(include_str!("fixtures/claude.jsonl"))).unwrap();
        assert_eq!(summary.event_count, 1);
        let counters = summary.buckets.values().next().unwrap();
        assert_eq!(counters.input_tokens, 100);
        assert_eq!(counters.output_tokens, 40);
        assert_eq!(counters.cache_read_tokens, 50);
        assert_eq!(counters.cache_write_tokens, 50);
        assert_eq!(counters.cache_write1h_tokens, 20);
        assert!(counters.cache_write1h_tokens <= counters.cache_write_tokens);
        assert_eq!(counters.reasoning_output_tokens, 7);
    }

    #[test]
    fn codex_prefers_request_delta_and_subtracts_input_subsets() {
        let summary =
            parse_codex_reader(Cursor::new(include_str!("fixtures/codex.jsonl"))).unwrap();
        assert_eq!(summary.event_count, 1);
        let ((hour, model), counters) = summary.buckets.iter().next().unwrap();
        assert_eq!(*hour, 1_800_007_200);
        assert_eq!(model, "gpt-test");
        assert_eq!(counters.input_tokens, 70);
        assert_eq!(counters.cache_read_tokens, 20);
        assert_eq!(counters.cache_write_tokens, 10);
        assert_eq!(counters.output_tokens, 30);
        assert_eq!(counters.reasoning_output_tokens, 5);
    }

    #[test]
    fn codex_falls_back_only_when_primary_record_is_absent() {
        let summary =
            parse_codex_reader(Cursor::new(include_str!("fixtures/codex_fallback.jsonl"))).unwrap();
        assert_eq!(summary.event_count, 1);
        let counters = summary.buckets.values().next().unwrap();
        assert_eq!(counters.input_tokens, 7);
        assert_eq!(counters.cache_read_tokens, 2);
        assert_eq!(counters.cache_write_tokens, 1);
    }

    #[test]
    fn codex_fallback_uses_monotonic_totals_and_ignores_rate_limit_repeats() {
        let summary = parse_codex_reader(Cursor::new(include_str!(
            "fixtures/codex_fallback_repeated.jsonl"
        )))
        .unwrap();
        assert_eq!(summary.event_count, 2);
        let counters = summary.buckets.values().next().unwrap();
        assert_eq!(counters.input_tokens, 11);
        assert_eq!(counters.cache_read_tokens, 3);
        assert_eq!(counters.cache_write_tokens, 1);
        assert_eq!(counters.output_tokens, 5);
    }

    #[test]
    fn codex_empty_response_ids_do_not_collapse_requests() {
        let summary = parse_codex_reader(Cursor::new(include_str!(
            "fixtures/codex_empty_response_ids.jsonl"
        )))
        .unwrap();
        assert_eq!(summary.event_count, 2);
        let counters = summary.buckets.values().next().unwrap();
        assert_eq!(counters.input_tokens, 21);
        assert_eq!(counters.cache_read_tokens, 6);
        assert_eq!(counters.cache_write_tokens, 3);
        assert_eq!(counters.output_tokens, 9);
    }

    #[test]
    fn gemini_normalizes_cached_and_reasoning_subsets() {
        let summary =
            parse_gemini_reader(Cursor::new(include_str!("fixtures/gemini.json"))).unwrap();
        assert_eq!(summary.event_count, 1);
        let counters = summary.buckets.values().next().unwrap();
        assert_eq!(counters.input_tokens, 80);
        assert_eq!(counters.cache_read_tokens, 25);
        assert_eq!(counters.output_tokens, 38);
        assert_eq!(counters.reasoning_output_tokens, 8);
        assert_eq!(
            counters.input_tokens + counters.cache_read_tokens + counters.output_tokens,
            143
        );
    }

    #[test]
    fn gemini_jsonl_replays_message_updates_by_id() {
        let summary =
            parse_gemini_jsonl_reader(Cursor::new(include_str!("fixtures/gemini.jsonl"))).unwrap();
        assert_eq!(summary.event_count, 2);
        let counters = summary.buckets.values().next().unwrap();
        assert_eq!(counters.input_tokens, 95);
        assert_eq!(counters.cache_read_tokens, 30);
        assert_eq!(counters.output_tokens, 43);
        assert_eq!(counters.reasoning_output_tokens, 9);
    }

    #[test]
    fn grok_reads_nested_context_and_deduplicates() {
        let summary = parse_grok_reader(Cursor::new(include_str!("fixtures/grok.jsonl"))).unwrap();
        assert_eq!(summary.event_count, 1);
        let ((_, model), counters) = summary.buckets.iter().next().unwrap();
        assert_eq!(model, "grok-test");
        assert_eq!(counters.input_tokens, 80);
        assert_eq!(counters.cache_read_tokens, 20);
        assert_eq!(counters.output_tokens, 40);
        assert_eq!(counters.reasoning_output_tokens, 6);
        assert!(counters.reasoning_output_tokens <= counters.output_tokens);
    }

    #[test]
    fn floors_rfc3339_and_millisecond_timestamps_to_utc_hour() {
        assert_eq!(
            timestamp_hour(&Value::String("2027-01-15T10:59:59+03:00".into())),
            Some(1_799_996_400)
        );
        assert_eq!(
            timestamp_hour(&Value::from(1_799_976_499_999_i64)),
            Some(1_799_974_800)
        );
    }

    #[test]
    fn local_hour_boundary_handles_fractional_utc_offsets() {
        let timestamp = 1_800_000_900;
        assert_eq!(
            hour_boundary_with_offset(timestamp, 5 * 3600 + 30 * 60),
            1_799_998_200
        );
        assert_eq!(
            hour_boundary_with_offset(timestamp, 5 * 3600 + 45 * 60),
            1_800_000_900
        );
    }

    #[test]
    fn compatible_files_without_usage_are_unsupported() {
        let status = build_source_status("gemini", "Gemini CLI", 2, 0, 0, 0);
        assert_eq!(status.status, "unsupported");
        assert!(status.detail.contains("счётчики токенов"));
    }

    #[test]
    fn serializes_camel_case_with_one_hour_write_as_a_subset() {
        let bucket = UsageBucket {
            hour: 1_800_007_200,
            provider: "claude".into(),
            model: "claude-test".into(),
            input_tokens: 100,
            output_tokens: 40,
            cache_read_tokens: 50,
            cache_write_tokens: 50,
            cache_write1h_tokens: 20,
            reasoning_output_tokens: 7,
        };
        assert!(bucket.cache_write1h_tokens <= bucket.cache_write_tokens);
        let serialized = serde_json::to_value(bucket).unwrap();
        assert_eq!(serialized["cacheWriteTokens"], 50);
        assert_eq!(serialized["cacheWrite1hTokens"], 20);
        assert!(serialized.get("cache_write_tokens").is_none());
    }

    #[test]
    fn opencode_incrementally_handles_append_update_and_delete() {
        let path = temporary_database_path("opencode");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "CREATE TABLE message (id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4)",
                params![
                    "message-1",
                    1_800_007_200_000_i64,
                    1_i64,
                    r#"{"role":"assistant","model":{"modelID":"open-test"},"tokens":{"input":10,"output":20,"reasoning":5,"cache":{"read":3,"write":2}},"time":{"completed":1800007200000}}"#
                ],
            )
            .unwrap();
        drop(connection);

        let summary = parse_opencode_file(&path).unwrap();
        assert_eq!(summary.event_count, 1);
        let counters = summary.buckets.values().next().unwrap();
        assert_eq!(counters.input_tokens, 10);
        assert_eq!(counters.output_tokens, 25);
        assert_eq!(counters.reasoning_output_tokens, 5);
        assert_eq!(counters.cache_read_tokens, 3);
        assert_eq!(counters.cache_write_tokens, 2);

        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4)",
                params![
                    "message-2",
                    1_800_007_300_000_i64,
                    2_i64,
                    r#"{"role":"assistant","model":{"modelID":"open-test"},"tokens":{"input":7,"output":4,"reasoning":1,"cache":{"read":0,"write":0}},"time":{"completed":1800007300000}}"#
                ],
            )
            .unwrap();
        drop(connection);
        let summary = parse_opencode_file(&path).unwrap();
        assert_eq!(summary.event_count, 2);
        assert_eq!(
            summary
                .buckets
                .values()
                .map(|counters| counters.input_tokens)
                .sum::<u64>(),
            17
        );

        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE message SET time_updated = ?1, data = ?2 WHERE id = ?3",
                params![
                    3_i64,
                    r#"{"role":"assistant","model":{"modelID":"open-test"},"tokens":{"input":30,"output":25,"reasoning":5,"cache":{"read":3,"write":2}},"time":{"completed":1800007200000}}"#,
                    "message-1"
                ],
            )
            .unwrap();
        drop(connection);
        let summary = parse_opencode_file(&path).unwrap();
        assert_eq!(summary.event_count, 2);
        assert_eq!(
            summary
                .buckets
                .values()
                .map(|counters| counters.input_tokens)
                .sum::<u64>(),
            37
        );

        let connection = Connection::open(&path).unwrap();
        connection
            .execute("DELETE FROM message WHERE id = ?1", ["message-2"])
            .unwrap();
        drop(connection);
        let summary = parse_opencode_file(&path).unwrap();
        assert_eq!(summary.event_count, 1);
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn localcode_reads_normalized_message_columns() {
        let path = temporary_database_path("localcode");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "CREATE TABLE messages (id TEXT, created_at INTEGER, model TEXT, tokens_input INTEGER, tokens_output INTEGER, cached_input_tokens INTEGER, cache_creation_tokens INTEGER)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO messages VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    "message-1",
                    1_800_007_200_000_i64,
                    "local-test",
                    20,
                    12,
                    5,
                    4
                ],
            )
            .unwrap();
        drop(connection);

        let summary = parse_localcode_file(&path).unwrap();
        fs::remove_file(&path).unwrap();
        assert_eq!(summary.event_count, 1);
        let counters = summary.buckets.values().next().unwrap();
        assert_eq!(counters.input_tokens, 15);
        assert_eq!(counters.output_tokens, 12);
        assert_eq!(counters.cache_read_tokens, 5);
        assert_eq!(counters.cache_write_tokens, 4);
    }

    fn temporary_database_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "costtoken-{label}-{}-{}.db",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }
}
