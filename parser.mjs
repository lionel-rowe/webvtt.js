// @ts-check

/**
 * @typedef {{
 * 	type: 'text'
 * 	value: string
 * } | {
 * 	type: 'object'
 * 	name: 'v' | 'lang'
 * 	classes: string[]
 * 	children: Node[]
 * 	value: string
 * } | {
 * 	type: 'object'
 * 	name: 'c' | 'i' | 'b' | 'u' | 'ruby' | 'rt'
 * 	classes: string[]
 * 	children: Node[]
 * }} Node
 */

/**
 * @typedef {{
 * 	direction: 'horizontal' | 'vertical'
 * 	id: string
 * 	startTime: number
 * 	endTime: number
 * 	text: string
 * 	lineAlign: 'start' | 'center' | 'end'
 * 	linePosition: 'auto' | number
 * 	pauseOnExit: boolean
 * 	positionAlign: 'auto' | 'start' | 'center' | 'end'
 * 	size: number
 * 	snapToLines: boolean
 * 	textPosition: 'auto' | number
 * 	tree: {
 * 		children: Node[]
 * 	}
 * }} Cue
 */

const defaultCueSettings = /** @type {const} */ ({
	direction: 'horizontal',
	snapToLines: true,
	linePosition: 'auto',
	lineAlign: 'start',
	textPosition: 'auto',
	positionAlign: 'auto',
	size: 100,
	alignment: 'center',
})

const NEWLINE = /\r\n|\r|\n/
const SPACE = /[\u0020\t\f]/
const NOSPACE = /[^\u0020\t\f]/

export class WebVttParser {
	/** @type {Record<string, string>} */
	entities
	/** @type {RegExp} */
	#entityRegex

	/** @param {Record<string, string>} [entities] */
	constructor(entities) {
		if (!entities) {
			entities = {
				// well-formed versions
				'&amp;': '&',
				'&lt;': '<',
				'&gt;': '>',
				'&lrm;': '\u200e',
				'&rlm;': '\u200f',
				'&nbsp;': '\u00a0',
				// lenient versions without trailing semicolon
				'&amp': '&',
				'&lt': '<',
				'&gt': '>',
				'&lrm': '\u200e',
				'&rlm': '\u200f',
				'&nbsp': '\u00a0',
			}
		}
		this.entities = entities
		this.#entityRegex = makeEntityRegex(entities)
	}

	/**
	 * @param {string} input
	 * @param {'metadata' | 'chapters'} mode
	 * @returns {{
	 * 	cues: Cue[]
	 * 	errors: { message: string, line: number, col?: number }[]
	 * 	time: number
	 * 	styles: string[]
	 * }}
	 */
	parse(input, mode) {
		// global search and replace for \0
		input = input.replace(/\0/g, '\ufffd')

		const startTime = Date.now()
		let linePos = 0
		const lines = input.split(NEWLINE)
		let alreadyCollected = false
		const styles = []
		/** @type {Cue[]} */
		const cues = []
		const errors = []
		const err = (message, col) => {
			errors.push({ message: message, line: linePos + 1, col: col })
		}

		const line = lines[linePos]
		const lineLength = line.length
		const signature = 'WEBVTT'
		let bom = 0
		let signatureLength = signature.length

		/* Byte order mark */
		if (line[0] === '\ufeff') {
			bom = 1
			signatureLength += 1
		}
		/* SIGNATURE */
		if (
			lineLength < signatureLength ||
			line.indexOf(signature) !== 0 + bom ||
			lineLength > signatureLength &&
				line[signatureLength] !== ' ' &&
				line[signatureLength] !== '\t'
		) {
			err('No valid signature. (File needs to start with "WEBVTT".)')
		}

		linePos++

		/* HEADER */
		while (lines[linePos] !== '' && lines[linePos] != null) {
			err('No blank line after the signature.')
			if (lines[linePos].indexOf('-->') !== -1) {
				alreadyCollected = true
				break
			}
			linePos++
		}

		/* CUE LOOP */
		while (lines[linePos] != null) {
			while (!alreadyCollected && lines[linePos] === '') {
				linePos++
			}
			if (!alreadyCollected && lines[linePos] == null) {
				break
			}

			/** @type {Cue} */
			const cue = {
				...defaultCueSettings,
				...{
					id: '',
					startTime: 0,
					endTime: 0,
					pauseOnExit: false,
					text: '',
					tree: { children: [] },
				},
			}

			let parseTimings = true

			if (lines[linePos].indexOf('-->') === -1) {
				cue.id = lines[linePos]

				// Not part of the specification's parser as these would just be ignored. However,
				// we want them to be conforming and not get "Cue identifier cannot be standalone".
				if (/^NOTE($|[ \t])/.test(cue.id)) { // .startsWith fails in Chrome
					linePos++
					while (lines[linePos] !== '' && lines[linePos] != null) {
						if (lines[linePos].indexOf('-->') !== -1) {
							err('Cannot have timestamp in a comment.')
						}
						linePos++
					}
					continue
				}

				/* STYLES */
				if (/^STYLE($|[ \t])/.test(cue.id)) {
					const style = []
					let invalid = false
					linePos++
					while (lines[linePos] !== '' && lines[linePos] != null) {
						if (lines[linePos].indexOf('-->') !== -1) {
							err('Cannot have timestamp in a style block.')
							invalid = true
						}
						style.push(lines[linePos])
						linePos++
					}
					if (cues.length) {
						err('Style blocks cannot appear after the first cue.')
						continue
					}
					if (!invalid) {
						styles.push(style.join('\n'))
					}
					continue
				}

				linePos++

				if (lines[linePos] === '' || lines[linePos] == null) {
					err('Cue identifier cannot be standalone.')
					continue
				}

				if (lines[linePos].indexOf('-->') === -1) {
					parseTimings = false
					err('Cue identifier needs to be followed by timestamp.')
					continue
				}
			}

			/* TIMINGS */
			alreadyCollected = false
			const timings = new WebVttCueTimingsAndSettingsParser(lines[linePos], err)
			let previousCueStart = 0
			if (cues.length > 0) {
				previousCueStart = cues[cues.length - 1].startTime
			}
			if (parseTimings && !timings.parse(cue, previousCueStart)) {
				/* BAD CUE */
				linePos++

				/* BAD CUE LOOP */
				while (lines[linePos] !== '' && lines[linePos] != null) {
					if (lines[linePos].indexOf('-->') !== -1) {
						alreadyCollected = true
						break
					}
					linePos++
				}
				// discard current cue and continue to next one
				continue
			}
			linePos++

			/* CUE TEXT LOOP */
			while (lines[linePos] !== '' && lines[linePos] != null) {
				if (lines[linePos].indexOf('-->') !== -1) {
					err('Blank line missing before cue.')
					alreadyCollected = true
					break
				}
				if (cue.text !== '') {
					cue.text += '\n'
				}
				cue.text += lines[linePos]
				linePos++
			}

			/* CUE TEXT PROCESSING */
			const cueTextParser = new WebVttCueTextParser(cue.text, err, mode, this.entities, this.#entityRegex)
			cue.tree = cueTextParser.parse(cue.startTime, cue.endTime)
			cues.push(cue)
		}
		cues.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
		/* END */
		return { cues: cues, errors: errors, time: Date.now() - startTime, styles }
	}
}

class WebVttCueTimingsAndSettingsParser {
	#line
	#pos
	#errorHandler

	constructor(line, errorHandler) {
		this.#line = line
		this.#pos = 0
		this.#errorHandler = errorHandler
	}

	parse(cue, previousCueStart) {
		this.#skip(SPACE)
		cue.startTime = this.#timestamp()
		if (cue.startTime == null) {
			return
		}
		if (cue.startTime < previousCueStart) {
			this.#err('Start timestamp is not greater than or equal to start timestamp of previous cue.')
		}
		if (NOSPACE.test(this.#line[this.#pos])) {
			this.#err("Timestamp not separated from '-->' by whitespace.")
		}
		this.#skip(SPACE)
		// 6-8
		if (this.#line[this.#pos] !== '-') {
			this.#err('No valid timestamp separator found.')
			return
		}
		this.#pos++
		if (this.#line[this.#pos] !== '-') {
			this.#err('No valid timestamp separator found.')
			return
		}
		this.#pos++
		if (this.#line[this.#pos] !== '>') {
			this.#err('No valid timestamp separator found.')
			return
		}
		this.#pos++
		if (NOSPACE.test(this.#line[this.#pos])) {
			this.#err("'-->' not separated from timestamp by whitespace.")
		}
		this.#skip(SPACE)
		cue.endTime = this.#timestamp()
		if (cue.endTime == null) {
			return
		}
		if (cue.endTime <= cue.startTime) {
			this.#err('End timestamp is not greater than start timestamp.')
		}

		this.#skip(SPACE)
		this.#parseSettings(this.#line.substring(this.#pos), cue)
		return true
	}

	parseTimestamp() {
		const ts = this.#timestamp()
		if (this.#line[this.#pos] != null) {
			this.#err('Timestamp must not have trailing characters.')
			return
		}
		return ts
	}

	#err(message) {
		this.#errorHandler(message, this.#pos + 1)
	}

	#skip(pattern) {
		while (
			this.#line[this.#pos] != null &&
			pattern.test(this.#line[this.#pos])
		) {
			this.#pos++
		}
	}

	#collect(pattern) {
		let str = ''
		while (
			this.#line[this.#pos] != null &&
			pattern.test(this.#line[this.#pos])
		) {
			str += this.#line[this.#pos]
			this.#pos++
		}
		return str
	}

	/* http://dev.w3.org/html5/webvtt/#collect-a-webvtt-timestamp */
	#timestamp() {
		let units = 'minutes'
		let val1, val2, val3, val4
		// 3
		if (this.#line[this.#pos] == null) {
			this.#err('No timestamp found.')
			return
		}
		// 4
		if (!/\d/.test(this.#line[this.#pos])) {
			this.#err('Timestamp must start with a character in the range 0-9.')
			return
		}
		// 5-7
		val1 = this.#collect(/\d/)
		if (val1.length > 2 || parseInt(val1, 10) > 59) {
			units = 'hours'
		}
		// 8
		if (this.#line[this.#pos] !== ':') {
			this.#err('No time unit separator found.')
			return
		}
		this.#pos++
		// 9-11
		val2 = this.#collect(/\d/)
		if (val2.length !== 2) {
			this.#err('Must be exactly two digits.')
			return
		}
		// 12
		if (units === 'hours' || this.#line[this.#pos] === ':') {
			if (this.#line[this.#pos] !== ':') {
				this.#err('No seconds found or minutes is greater than 59.')
				return
			}
			this.#pos++
			val3 = this.#collect(/\d/)
			if (val3.length !== 2) {
				this.#err('Must be exactly two digits.')
				return
			}
		} else {
			if (val1.length !== 2) {
				this.#err('Must be exactly two digits.')
				return
			}
			val3 = val2
			val2 = val1
			val1 = '0'
		}
		// 13
		if (this.#line[this.#pos] !== '.') {
			this.#err('No decimal separator (".") found.')
			return
		}
		this.#pos++
		// 14-16
		val4 = this.#collect(/\d/)
		if (val4.length !== 3) {
			this.#err('Milliseconds must be given in three digits.')
			return
		}
		// 17
		if (parseInt(val2, 10) > 59) {
			this.#err('You cannot have more than 59 minutes.')
			return
		}
		if (parseInt(val3, 10) > 59) {
			this.#err('You cannot have more than 59 seconds.')
			return
		}
		return parseInt(val1, 10) * 60 * 60 + parseInt(val2, 10) * 60 + parseInt(val3, 10) + parseInt(val4, 10) / 1000
	}

	/* http://dev.w3.org/html5/webvtt/#parse-the-webvtt-settings */
	#parseSettings(input, cue) {
		const settings = input.split(SPACE)
		const seen = []
		for (let i = 0; i < settings.length; i++) {
			if (settings[i] === '') {
				continue
			}

			const index = settings[i].indexOf(':')
			const setting = settings[i].slice(0, index)
			let value = settings[i].slice(index + 1)

			if (seen.indexOf(setting) !== -1) {
				this.#err('Duplicate setting.')
			}
			seen.push(setting)

			if (value === '') {
				this.#err('No value for setting defined.')
				return
			}

			if (setting === 'vertical') { // writing direction
				if (value !== 'rl' && value !== 'lr') {
					this.#err("Writing direction can only be set to 'rl' or 'rl'.")
					continue
				}
				cue.direction = value
			} else if (setting === 'line') { // line position and optionally line alignment
				let lineAlign

				if (/,/.test(value)) {
					const comp = value.split(',')
					value = comp[0]
					lineAlign = comp[1]
				}
				if (!/^[-\d](\d*)(\.\d+)?%?$/.test(value)) {
					this.#err('Line position takes a number or percentage.')
					continue
				}
				if (value.indexOf('-', 1) !== -1) {
					this.#err("Line position can only have '-' at the start.")
					continue
				}
				if (value.indexOf('%') !== -1 && value.indexOf('%') !== value.length - 1) {
					this.#err("Line position can only have '%' at the end.")
					continue
				}
				if (value[0] === '-' && value[value.length - 1] === '%') {
					this.#err('Line position cannot be a negative percentage.')
					continue
				}
				let numVal = value
				let isPercent = false
				if (value[value.length - 1] === '%') {
					isPercent = true
					numVal = value.slice(0, value.length - 1)
					if (parseInt(value, 10) > 100) {
						this.#err('Line position cannot be >100%.')
						continue
					}
				}
				if (numVal === '' || isNaN(numVal) || !isFinite(numVal)) {
					this.#err('Line position needs to be a number')
					continue
				}
				if (lineAlign != null) {
					if (!['start', 'center', 'end'].includes(lineAlign)) {
						this.#err('Line alignment needs to be one of start, center or end')
						continue
					}
					cue.lineAlign = lineAlign
				}
				cue.snapToLines = !isPercent
				cue.linePosition = parseFloat(numVal)
				if (parseFloat(numVal).toString() !== numVal) {
					cue.nonSerializable = true
				}
			} else if (setting === 'position') { // text position and optional positionAlign
				if (/,/.test(value)) {
					const comp = value.split(',')
					value = comp[0]
					var positionAlign = comp[1]
				}
				if (value[value.length - 1] !== '%') {
					this.#err('Text position must be a percentage.')
					continue
				}
				if (parseInt(value, 10) > 100 || parseInt(value, 10) < 0) {
					this.#err('Text position needs to be between 0 and 100%.')
					continue
				}
				const numVal = value.slice(0, value.length - 1)
				if (numVal === '' || isNaN(numVal) || !isFinite(numVal)) {
					this.#err('Line position needs to be a number')
					continue
				}
				if (positionAlign != null) {
					if (!['line-left', 'center', 'line-right'].includes(positionAlign)) {
						this.#err('Position alignment needs to be one of line-left, center or line-right')
						continue
					}
					cue.positionAlign = positionAlign
				}
				cue.textPosition = parseFloat(numVal)
			} else if (setting === 'size') { // size
				if (value[value.length - 1] !== '%') {
					this.#err('Size must be a percentage.')
					continue
				}
				if (parseInt(value, 10) > 100) {
					this.#err('Size cannot be >100%.')
					continue
				}
				let size = value.slice(0, value.length - 1)
				if (size == null || size === '' || isNaN(size)) {
					this.#err('Size needs to be a number')
					size = 100
					continue
				} else {
					size = parseFloat(size)
					if (size < 0 || size > 100) {
						this.#err('Size needs to be between 0 and 100%.')
						continue
					}
				}
				cue.size = size
			} else if (setting === 'align') { // alignment
				const alignValues = ['start', 'center', 'end', 'left', 'right']
				if (alignValues.indexOf(value) === -1) {
					this.#err('Alignment can only be set to one of ' + alignValues.join(', ') + '.')
					continue
				}
				cue.alignment = value
			} else {
				this.#err('Invalid setting.')
			}
		}
	}
}

class WebVttCueTextParser {
	#entityRegex
	#line
	#pos
	mode
	#errorHandler

	constructor(line, errorHandler, mode, entities, entityRegex = makeEntityRegex(entities)) {
		this.entities = entities
		this.#entityRegex = entityRegex
		this.#errorHandler = errorHandler
		this.#line = line
		this.#pos = 0
		this.mode = mode
	}

	parse(cueStart, cueEnd) {
		const removeCycles = (tree) => {
			const cyclelessTree = { ...tree }
			if (tree.children) {
				cyclelessTree.children = tree.children.map(removeCycles)
			}
			if (cyclelessTree.parent) {
				delete cyclelessTree.parent
			}
			return cyclelessTree
		}

		const result = { children: [] }
		/** @type {any} */
		let current = result
		const timestamps = []

		const attach = (token) => {
			current.children.push({ type: 'object', name: token[1], classes: token[2], children: [], parent: current })
			current = current.children[current.children.length - 1]
		}

		const inScope = (name) => {
			let node = current
			while (node) {
				if (node.name === name) {
					return true
				}
				node = node.parent
			}
			return
		}

		while (this.#line[this.#pos] != null) {
			/** @type {any} */
			const token = this.#nextToken()
			if (token[0] === 'text') {
				current.children.push({ type: 'text', value: token[1], parent: current })
			} else if (token[0] === 'start tag') {
				if (this.mode === 'chapters') {
					this.#err('Start tags not allowed in chapter title text.')
				}
				const name = token[1]
				if (name !== 'v' && name !== 'lang' && token[3] !== '') {
					this.#err('Only <v> and <lang> can have an annotation.')
				}
				if (name === 'c' || name === 'i' || name === 'b' || name === 'u' || name === 'ruby') {
					attach(token)
				} else if (name === 'rt' && current.name === 'ruby') {
					attach(token)
				} else if (name === 'v') {
					if (inScope('v')) {
						this.#err('<v> cannot be nested inside itself.')
					}
					attach(token)
					current.value = token[3] // annotation
					if (!token[3]) {
						this.#err('<v> requires an annotation.')
					}
				} else if (name === 'lang') {
					attach(token)
					current.value = token[3] // language
				} else {
					this.#err('Incorrect start tag.')
				}
			} else if (token[0] === 'end tag') {
				if (this.mode === 'chapters') {
					this.#err('End tags not allowed in chapter title text.')
				}
				// XXX check <ruby> content
				if (token[1] === current.name) {
					current = current.parent
				} else if (token[1] === 'ruby' && current.name === 'rt') {
					current = current.parent.parent
				} else {
					this.#err('Incorrect end tag.')
				}
			} else if (token[0] === 'timestamp') {
				if (this.mode === 'chapters') {
					this.#err('Timestamp not allowed in chapter title text.')
				}
				const timings = new WebVttCueTimingsAndSettingsParser(token[1], this.#err.bind(this))
				const timestamp = timings.parseTimestamp()
				if (timestamp != null) {
					if (timestamp <= cueStart || timestamp >= cueEnd) {
						this.#err('Timestamp must be between start timestamp and end timestamp.')
					}
					if (timestamps.length > 0 && timestamps[timestamps.length - 1] >= timestamp) {
						this.#err('Timestamp must be greater than any previous timestamp.')
					}
					current.children.push({ type: 'timestamp', value: timestamp, parent: current })
					timestamps.push(timestamp)
				}
			}
		}
		while (current.parent) {
			if (current.name !== 'v') {
				this.#err('Required end tag missing.')
			}
			current = current.parent
		}
		return removeCycles(result)
	}

	#err(message) {
		if (this.mode === 'metadata') return
		this.#errorHandler(message, this.#pos + 1)
	}

	#nextToken() {
		let state = 'data'
		let result = ''
		let buffer = ''
		const classes = []

		while (this.#line[this.#pos - 1] != null || this.#pos === 0) {
			const c = this.#line[this.#pos]
			if (state === 'data') {
				if (c === '&') {
					const match = this.#line.slice(this.#pos).match(this.#entityRegex)
					if (match) {
						result += this.entities[match[0]]
						this.#pos += match[0].length - 1
					} else {
						buffer = c
						state = 'escape'
					}
				} else if (c === '<' && result === '') {
					state = 'tag'
				} else if (c === '<' || c == null) {
					return ['text', result]
				} else {
					result += c
				}
			} else if (state === 'escape') {
				if (c === '<' || c == null) {
					this.#err('Incorrect escape.')
					let m
					if (m = buffer.match(/^&#([0-9]+)$/)) {
						result += String.fromCodePoint(Number(m[1]))
					} else {
						result += buffer
					}
					return ['text', result]
				} else if (c === '&') {
					this.#err('Incorrect escape.')
					result += buffer
					buffer = c
				} else if (/[a-z#0-9]/i.test(c)) {
					buffer += c
				} else if (c === ';') {
					let m
					if (m = buffer.match(/^&#(x)?([0-9]+)$/)) {
						result += String.fromCodePoint(parseInt(m[2], m[1] ? 16 : 10))
					} else {
						this.#err('Incorrect escape.')
						result += buffer + ';'
					}
					state = 'data'
				} else {
					this.#err('Incorrect escape.')
					result += buffer + c
					state = 'data'
				}
			} else if (state === 'tag') {
				if (c === '\t' || c === '\n' || c === '\f' || c === ' ') {
					state = 'start tag annotation'
				} else if (c === '.') {
					state = 'start tag class'
				} else if (c === '/') {
					state = 'end tag'
				} else if (/\d/.test(c)) {
					result = c
					state = 'timestamp tag'
				} else if (c === '>' || c == null) {
					if (c === '>') {
						this.#pos++
					}
					return ['start tag', '', [], '']
				} else {
					result = c
					state = 'start tag'
				}
			} else if (state === 'start tag') {
				if (c === '\t' || c === '\f' || c === ' ') {
					state = 'start tag annotation'
				} else if (c === '\n') {
					buffer = c
					state = 'start tag annotation'
				} else if (c === '.') {
					state = 'start tag class'
				} else if (c === '>' || c == null) {
					if (c === '>') {
						this.#pos++
					}
					return ['start tag', result, [], '']
				} else {
					result += c
				}
			} else if (state === 'start tag class') {
				if (c === '\t' || c === '\f' || c === ' ') {
					if (buffer) {
						classes.push(buffer)
					}
					buffer = ''
					state = 'start tag annotation'
				} else if (c === '\n') {
					if (buffer) {
						classes.push(buffer)
					}
					buffer = c
					state = 'start tag annotation'
				} else if (c === '.') {
					if (buffer) {
						classes.push(buffer)
					}
					buffer = ''
				} else if (c === '>' || c == null) {
					if (c === '>') {
						this.#pos++
					}
					if (buffer) {
						classes.push(buffer)
					}
					return ['start tag', result, classes, '']
				} else {
					buffer += c
				}
			} else if (state === 'start tag annotation') {
				if (c === '>' || c == null) {
					if (c === '>') {
						this.#pos++
					}
					buffer = buffer.split(/[\u0020\t\f\r\n]+/).filter(Boolean).join(' ')
					return ['start tag', result, classes, buffer]
				} else {
					buffer += c
				}
			} else if (state === 'end tag') {
				if (c === '>' || c == null) {
					if (c === '>') {
						this.#pos++
					}
					return ['end tag', result]
				} else {
					result += c
				}
			} else if (state === 'timestamp tag') {
				if (c === '>' || c == null) {
					if (c === '>') {
						this.#pos++
					}
					return ['timestamp', result]
				} else {
					result += c
				}
			} else {
				this.#err('Never happens.') // The joke is it might.
			}
			// 8
			this.#pos++
		}
	}
}

export class WebVttSerializer {
	/**
	 * @param {Cue[]} cues
	 * @param {string[]} [styles]
	 * @returns {string}
	 */
	serialize(cues, styles) {
		let result = 'WEBVTT\n\n'
		if (styles) {
			for (let i = 0; i < styles.length; i++) {
				result += this.#serializeStyle(styles[i])
			}
		}
		for (let i = 0; i < cues.length; i++) {
			result += this.#serializeCue(cues[i])
		}
		return result
	}

	#serializeTimestamp(seconds) {
		const ms = String(Math.round(1000 * (Number(seconds) % 1))).padStart(3, '0')
		let h = 0, m = 0, s = 0
		if (seconds >= 3600) {
			h = Math.floor(seconds / 3600)
		}
		m = Math.floor((seconds - 3600 * h) / 60)
		s = Math.floor(seconds - 3600 * h - 60 * m)
		return (h ? h + ':' : '') + ('' + m).padStart(2, '0') + ':' + ('' + s).padStart(2, '0') + '.' + ms
	}

	#serializeCueSettings(cue) {
		let result = ''
		const nonDefaultSettings = Object.keys(defaultCueSettings).filter((s) => cue[s] !== defaultCueSettings[s])
		if (nonDefaultSettings.includes('direction')) {
			result += ' vertical:' + cue.direction
		}
		if (nonDefaultSettings.includes('alignment')) {
			result += ' align:' + cue.alignment
		}
		if (nonDefaultSettings.includes('size')) {
			result += ' size:' + cue.size + '%'
		}
		if (nonDefaultSettings.includes('lineAlign') || nonDefaultSettings.includes('linePosition')) {
			result += ' line:' + cue.linePosition + (cue.snapToLines ? '' : '%') +
				(cue.lineAlign && cue.lineAlign !== defaultCueSettings.lineAlign ? ',' + cue.lineAlign : '')
		}
		if (nonDefaultSettings.includes('textPosition') || nonDefaultSettings.includes('positionAlign')) {
			result += ' position:' + cue.textPosition + '%' +
				(cue.positionAlign && cue.positionAlign !== defaultCueSettings.positionAlign
					? ',' + cue.positionAlign
					: '')
		}
		return result
	}

	#serializeTree(tree) {
		let result = ''
		for (let i = 0; i < tree.length; i++) {
			const node = tree[i]
			if (node.type === 'text') {
				result += node.value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
			} else if (node.type === 'object') {
				result += '<' + node.name
				if (node.classes) {
					for (let y = 0; y < node.classes.length; y++) {
						result += '.' + node.classes[y]
					}
				}
				if (node.value) {
					result += ' ' + node.value
				}
				result += '>'
				if (node.children) {
					result += this.#serializeTree(node.children)
				}
				result += '</' + node.name + '>'
			} else if (node.type === 'timestamp') {
				result += '<' + this.#serializeTimestamp(node.value) + '>'
			} else {
				result += '<' + node.value + '>'
			}
		}
		return result
	}

	#serializeCue(cue) {
		return (cue.id != null ? cue.id + '\n' : '') +
			this.#serializeTimestamp(cue.startTime) +
			' --> ' +
			this.#serializeTimestamp(cue.endTime) +
			this.#serializeCueSettings(cue) +
			'\n' + this.#serializeTree(cue.tree.children) + '\n\n'
	}

	#serializeStyle(style) {
		return 'STYLE\n' + style + '\n\n'
	}
}

/** @param {Record<string, string>} entities */
function makeEntityRegex(entities) {
	return new RegExp(`^(?:${Object.keys(entities).sort((a, b) => b.length - a.length).join('|')})`)
}
