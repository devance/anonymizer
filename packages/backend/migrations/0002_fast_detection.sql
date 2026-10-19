-- Fast detection (the engine's small model and the rules) now reads every
-- document. A Gemma model picked at onboarding, when it was the only way to
-- find names, becomes an opt-in deep check: back to fast detection alone.
UPDATE settings SET value = '{"engine":"none"}', updated_at = unixepoch() WHERE key = 'detector';
