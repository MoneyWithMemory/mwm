import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import type { Role } from '@/api'
import { SegmentedControl, TextArea } from '@/components/ui'
import { accordion, textSwap } from '@/lib/motion'
import { OTHER_DESCRIPTION, PROMPT_MAX_LENGTH, STRATEGIES, strategyOf, type StrategyId } from './strategies'

interface StrategyPickerProps {
  role: Role
  /** The strategy sent to the agent: a preset's prompt or the owner's own text. */
  value: string
  onChange: (prompt: string) => void
  layoutId: string
}

/**
 * Strict / Balanced / Flexible with a fixed description, or Other with the owner's own words.
 * The choice is local state: clearing the custom text keeps "Other" open.
 */
export function StrategyPicker({ role, value, onChange, layoutId }: StrategyPickerProps) {
  const presets = STRATEGIES[role]
  const [mode, setMode] = useState<StrategyId>(() => strategyOf(role, value))
  const [custom, setCustom] = useState(() => (strategyOf(role, value) === 'other' ? value : ''))

  const select = (id: StrategyId) => {
    setMode(id)
    onChange(id === 'other' ? custom : (presets.find((p) => p.id === id)?.prompt ?? ''))
  }
  const description = presets.find((p) => p.id === mode)?.description ?? OTHER_DESCRIPTION

  return (
    <div className="flex flex-col">
      <SegmentedControl
        fullWidth
        size="md"
        layoutId={layoutId}
        options={[...presets.map((p) => ({ value: p.id, label: p.label })), { value: 'other' as const, label: 'Other' }]}
        value={mode}
        onChange={select}
      />
      {/* Two lines reserved: switching presets never moves what follows. */}
      <div className="mt-3 min-h-10">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p key={mode} className="text-sm leading-5 text-fg/80" variants={textSwap} initial="initial" animate="animate" exit="exit">
            {description}
          </motion.p>
        </AnimatePresence>
      </div>
      <AnimatePresence initial={false}>
        {mode === 'other' && (
          <motion.div key="custom" className="overflow-hidden" variants={accordion} initial="initial" animate="animate" exit="exit">
            <TextArea
              aria-label="Your strategy"
              placeholder="e.g. Hold firm for three rounds, then meet in the middle."
              rows={2}
              maxLength={PROMPT_MAX_LENGTH}
              value={custom}
              hint={custom ? `${custom.length}/${PROMPT_MAX_LENGTH}` : undefined}
              containerClassName="pt-3"
              onChange={(event) => {
                setCustom(event.target.value)
                onChange(event.target.value)
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
