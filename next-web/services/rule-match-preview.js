function normalize(value, form) {
  return form ? value.normalize(form) : value;
}

// Keep this predicate aligned with common/lib/chinachu-common.js#programMatchesRule.
// It is intentionally browser-side so editing a rule never saves it or runs Scheduler.
export function programMatchesRulePreview(rule, program, normalizationForm) {
  let found;
  const title = normalize(program.fullTitle, normalizationForm);
  const detail = program.detail ? normalize(program.detail, normalizationForm) : null;

  if (rule.isDisabled) return false;
  if (rule.sid && rule.sid !== program.channel.sid) return false;
  if (rule.types && !rule.types.includes(program.channel.type)) return false;
  if (rule.channels && !rule.channels.includes(program.channel.id)
    && !rule.channels.includes(program.channel.channel)
    && !rule.channels.includes(`${program.channel.type}_${program.channel.sid}`)) return false;
  if (rule.ignore_channels && (rule.ignore_channels.includes(program.channel.id)
    || rule.ignore_channels.includes(program.channel.channel)
    || rule.ignore_channels.includes(`${program.channel.type}_${program.channel.sid}`))) return false;
  if (rule.category && rule.category !== program.category) return false;
  if (rule.categories && !rule.categories.includes(program.category)) return false;

  if (rule.hour && typeof rule.hour.start === 'number' && typeof rule.hour.end === 'number'
    && !(rule.hour.start === 0 && rule.hour.end === 24)) {
    const ruleStart = rule.hour.start;
    const ruleEnd = rule.hour.end;
    const programStart = new Date(program.start).getHours();
    let programEnd = new Date(program.end).getHours();
    if (programStart > programEnd) programEnd += 24;
    if (new Date(program.end).getMinutes() === 0) programEnd -= 1;
    if (ruleStart > ruleEnd) {
      if (ruleStart > programStart && ruleEnd < programEnd) return false;
    } else if (ruleStart > programStart || ruleEnd < programEnd) return false;
  }

  if (rule.duration && rule.duration.min !== undefined && rule.duration.max !== undefined
    && (rule.duration.min > program.seconds || rule.duration.max < program.seconds)) return false;

  if (rule.reserve_titles) {
    const requireAll = rule.reserve_titles_mode === 'and';
    found = requireAll && rule.reserve_titles.length > 0;
    for (const pattern of rule.reserve_titles) {
      const matched = title.match(normalize(pattern, normalizationForm)) !== null;
      if (requireAll && !matched) { found = false; break; }
      if (!requireAll && matched) { found = true; break; }
    }
    if (!found) return false;
  }

  if (rule.ignore_titles) {
    for (const pattern of rule.ignore_titles) {
      if (title.match(normalize(pattern, normalizationForm)) !== null) return false;
    }
  }

  if (rule.reserve_descriptions) {
    if (!detail) return false;
    found = false;
    for (const pattern of rule.reserve_descriptions) {
      if (detail.match(normalize(pattern, normalizationForm)) !== null) found = true;
    }
    if (!found) return false;
  }

  if (rule.ignore_descriptions && detail) {
    for (const pattern of rule.ignore_descriptions) {
      if (detail.match(normalize(pattern, normalizationForm)) !== null) return false;
    }
  }

  if (rule.ignore_flags) {
    for (const flag of rule.ignore_flags) {
      for (const programFlag of program.flags) if (flag === programFlag) return false;
    }
  }

  if (rule.reserve_flags) {
    if (!program.flags) return false;
    found = false;
    for (const flag of rule.reserve_flags) {
      for (const programFlag of program.flags) if (flag === programFlag) found = true;
    }
    if (!found) return false;
  }
  return true;
}

export function schedulePrograms(schedule) {
  return (Array.isArray(schedule) ? schedule : []).flatMap(channel =>
    (Array.isArray(channel?.programs) ? channel.programs : []).map(program => ({
      ...program,
      channel: program.channel || channel
    }))
  );
}

export function buildRuleMatchQuery(rule, normalizationForm) {
  const previewRule = structuredClone(rule || {});
  delete previewRule.isDisabled;
  return { version: 1, rule: previewRule, normalizationForm: normalizationForm || null };
}

export function previewRuleMatches(rule, programs, normalizationForm) {
  const query = buildRuleMatchQuery(rule, normalizationForm);
  const matches = programs.filter(program => programMatchesRulePreview(query.rule, program, normalizationForm));
  return { count: matches.length, programs: matches, query };
}
