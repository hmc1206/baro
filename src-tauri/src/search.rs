use crate::indexer::AppEntry;
use fuzzy_matcher::{skim::SkimMatcherV2, FuzzyMatcher};
use std::collections::HashMap;

// 퍼지 점수(표시 이름·파일 이름 중 높은 쪽) + 사용 빈도 가중치
pub fn rank(apps: &[AppEntry], usage: &HashMap<String, u32>, q: &str, n: usize) -> Vec<AppEntry> {
    let m = SkimMatcherV2::default();
    let mut v: Vec<(i64, &AppEntry)> = apps.iter()
        .filter_map(|a| {
            let s = m.fuzzy_match(&a.name, q).max(m.fuzzy_match(&a.alias, q))?;
            Some((s + *usage.get(&a.path).unwrap_or(&0) as i64 * 10, a))
        })
        .collect();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().take(n).map(|(_, a)| a.clone()).collect()
}
