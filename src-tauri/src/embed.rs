// 노트 뜻 검색용 임베딩 (로컬 Ollama bge-m3)
// - 단락 글의 해시 → 벡터(1024개 f32). embed-cache.bin(나만 읽기 권한)에 저장, 바뀐 단락만 새로 계산
// - 처음 전체 만들기는 사용자가 "노트 뜻 색인 만들기"로 실행 (몇 분 CPU·GPU 사용). 그 뒤엔 질문할 때 바뀐 단락만
// - Ollama가 꺼져 있거나 모델이 없으면 조용히 단어 검색(BM25)만 사용
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub const MODEL: &str = "bge-m3";
const MAX_CHARS: usize = 2000;
const MAGIC: &[u8; 8] = b"BAROE8\0\0";
// 메모리·파일 모두 1바이트 정수로 줄여 저장 (벡터마다 배율 하나). 처음 쓸 때만 파일을 읽음
struct Q { scale: f32, v: Vec<i8> }
static STORE: Mutex<Option<HashMap<u64, Q>>> = Mutex::new(None);
static FILE: OnceLock<PathBuf> = OnceLock::new();
pub static BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn key(text: &str) -> u64 { crate::vault::hash64(&[MODEL.as_bytes(), text.as_bytes()]) }

// 예전 키 (std DefaultHasher, Rust 버전마다 달라질 수 있음). 기존 캐시를 새 키로 옮기는 데만 씀
// TODO(2027-01): 모두 옮겨졌으면 legacy_key·adopt 삭제
pub fn legacy_key(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    MODEL.hash(&mut h);
    text.hash(&mut h);
    h.finish()
}

// 예전 키로 저장된 벡터를 새 키로 옮김 (다시 계산하지 않게). 옮긴 개수
pub fn adopt(pairs: &[(u64, u64)]) -> usize {
    with(|m| {
        let mut n = 0;
        for &(old, new) in pairs {
            if m.contains_key(&new) { continue; }
            if let Some(q) = m.remove(&old) { m.insert(new, q); n += 1; }
        }
        n
    })
}

pub fn clip(text: &str) -> String { text.chars().take(MAX_CHARS).collect() }

fn quant(v: &[f32]) -> Q {
    let m = v.iter().fold(0f32, |a, x| a.max(x.abs())).max(1e-9);
    Q { scale: m / 127.0, v: v.iter().map(|x| (x / m * 127.0).round() as i8).collect() }
}

pub fn init(file: &Path) { let _ = FILE.set(file.to_path_buf()); }

// 파일 형식: MAGIC, [개수 u64][차원 u64], (키 u64, 배율 f32, i8 × 차원) 반복. 예전 f32 형식(MAGIC 없음)도 읽음
fn load() -> HashMap<u64, Q> {
    let mut map = HashMap::new();
    let Some(f) = FILE.get() else { return map };
    let Ok(mut file) = std::fs::File::open(f) else { return map };
    let mut b = vec![];
    if file.read_to_end(&mut b).is_err() { return map; }
    let new = b.starts_with(MAGIC);
    let h = if new { 8 } else { 0 };
    if b.len() < h + 16 { return map; }
    let n = u64::from_le_bytes(b[h..h + 8].try_into().unwrap()) as usize;
    let dim = u64::from_le_bytes(b[h + 8..h + 16].try_into().unwrap()) as usize;
    let rec = if new { 12 + dim } else { 8 + dim * 4 };
    if dim == 0 || b.len() < h + 16 + n * rec { return map; }
    for i in 0..n {
        let o = h + 16 + i * rec;
        let k = u64::from_le_bytes(b[o..o + 8].try_into().unwrap());
        let q = if new {
            Q { scale: f32::from_le_bytes(b[o + 8..o + 12].try_into().unwrap()), v: b[o + 12..o + rec].iter().map(|&x| x as i8).collect() }
        } else {
            quant(&b[o + 8..o + rec].chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect::<Vec<_>>())
        };
        map.insert(k, q);
    }
    map
}

fn with<R>(f: impl FnOnce(&mut HashMap<u64, Q>) -> R) -> R {
    let mut g = STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    f(g.get_or_insert_with(load))
}

// keep: 지금 색인에 있는 단락만 남기고 저장 (지운·바뀐 단락의 옛 벡터 정리)
pub fn save(keep: Option<&std::collections::HashSet<u64>>) {
    let Some(f) = FILE.get() else { return };
    let b = with(|map| {
        if let Some(k) = keep { map.retain(|key, _| k.contains(key)); }
        let dim = map.values().next().map(|q| q.v.len()).unwrap_or(0);
        let mut b = Vec::with_capacity(24 + map.len() * (12 + dim));
        b.extend(MAGIC);
        b.extend((map.values().filter(|q| q.v.len() == dim).count() as u64).to_le_bytes());
        b.extend((dim as u64).to_le_bytes());
        for (k, q) in map.iter().filter(|(_, q)| q.v.len() == dim) {
            b.extend(k.to_le_bytes());
            b.extend(q.scale.to_le_bytes());
            b.extend(q.v.iter().map(|&x| x as u8));
        }
        b
    });
    let tmp = f.with_extension("bin.tmp");
    let Ok(mut out) = std::fs::File::create(&tmp) else { return };
    if out.write_all(&b).is_err() { return; }
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)); }
    let _ = std::fs::rename(&tmp, f);
}

// 질문 벡터(길이 1)와 저장된 단락 벡터의 코사인
pub fn score(qv: &[f32], k: u64) -> Option<f32> {
    with(|m| m.get(&k).map(|q| q.v.iter().zip(qv).map(|(&a, b)| a as f32 * b).sum::<f32>() * q.scale))
}
pub fn has(k: u64) -> bool { with(|m| m.contains_key(&k)) }
pub fn count() -> usize { with(|m| m.len()) }
fn put(k: u64, v: Vec<f32>) { with(|m| { m.insert(k, quant(&v)); }); }
// 파일이 있는지만 (메모리에 올리지 않고)
pub fn exists() -> bool { STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref().is_some_and(|m| !m.is_empty()) || FILE.get().is_some_and(|f| f.exists()) }

// 길이 1로 맞춘 벡터 (코사인 = 내적)
fn unit(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 { v.iter_mut().for_each(|x| *x /= n); }
    v
}

// Ollama /api/embed. 실패하면 Err (모델 없음·꺼짐)
pub async fn embed(url: &str, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    let res = reqwest::Client::new().post(format!("{url}/api/embed"))
        .timeout(std::time::Duration::from_secs(120))
        .json(&json!({ "model": MODEL, "input": texts })).send().await
        .map_err(|_| "Ollama에 연결하지 못했어요.".to_string())?;
    if res.status().as_u16() == 404 { return Err(format!("{MODEL} 모델이 없어요. 터미널에서 `ollama pull {MODEL}`")); }
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    if let Some(e) = v["error"].as_str() { return Err(e.to_string()); }
    let list = v["embeddings"].as_array().ok_or("임베딩 응답 형식이 달라요")?;
    Ok(list.iter().map(|e| unit(e.as_array().map(|a| a.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect()).unwrap_or_default())).collect())
}

// 없는 것만 계산해 저장. 진행 콜백(완료, 전체)
pub async fn fill(url: &str, items: &[(u64, String)], batch: usize, mut progress: impl FnMut(usize, usize)) -> Result<usize, String> {
    let todo: Vec<&(u64, String)> = items.iter().filter(|(k, _)| !has(*k)).collect();
    let total = todo.len();
    let mut done = 0;
    for chunk in todo.chunks(batch.max(1)) {
        let texts: Vec<String> = chunk.iter().map(|(_, t)| t.clone()).collect();
        let vs = embed(url, &texts).await?;
        for ((k, _), v) in chunk.iter().zip(vs) { put(*k, v); }
        done += chunk.len();
        progress(done, total);
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_roundtrip_quantized_and_prune() {
        let f = std::env::temp_dir().join(format!("baro-embed-{}.bin", std::process::id()));
        let _ = std::fs::remove_file(&f);
        init(&f);
        put(1, unit(vec![3.0, 4.0]));
        put(2, unit(vec![1.0, 0.0]));
        save(None);
        *STORE.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None; // 다시 켠 것처럼
        assert!((score(&[0.6, 0.8], 1).unwrap() - 1.0).abs() < 0.01);
        assert!((score(&[0.6, 0.8], 2).unwrap() - 0.6).abs() < 0.01);
        save(Some(&[2u64].into_iter().collect()));
        assert!(!has(1) && has(2));
        assert_eq!(adopt(&[(2, 7)]), 1); // 예전 키 → 새 키
        assert!(!has(2) && has(7));
        let _ = std::fs::remove_file(&f);
    }
}
