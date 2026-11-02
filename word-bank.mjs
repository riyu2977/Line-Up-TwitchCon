const WORD_GROUPS = Object.freeze({
  animals: {
    easy: ['cat', 'dog', 'cow', 'pig', 'duck', 'rabbit', 'horse', 'chicken', 'sheep'],
    medium: ['fox', 'bear', 'wolf', 'deer', 'elephant', 'giraffe', 'zebra', 'monkey', 'goat', 'goose'],
    hard: ['panda', 'penguin', 'dolphin', 'whale', 'octopus', 'turtle'],
  },
  objects: {
    easy: ['chair', 'table', 'lamp', 'clock', 'key', 'cup', 'plate', 'spoon', 'fork', 'bottle'],
    medium: ['mirror', 'ladder', 'umbrella', 'suitcase', 'backpack', 'candle', 'lock', 'scissors', 'hammer', 'bucket'],
    hard: ['saw', 'shovel', 'comb', 'toothbrush', 'telescope'],
  },
  food: {
    easy: ['apple', 'banana', 'orange', 'grape', 'carrot', 'potato', 'bread', 'cheese', 'pizza', 'burger'],
    medium: ['watermelon', 'strawberry', 'pineapple', 'tomato', 'broccoli', 'mushroom', 'sandwich', 'pancake', 'cookie', 'taco'],
    hard: ['waffle', 'cupcake', 'ice cream', 'popcorn', 'sushi'],
  },
  nature: {
    easy: ['tree', 'leaf', 'flower', 'cloud', 'beach', 'river', 'mountain', 'rainbow', 'ocean'],
    medium: ['waterfall', 'volcano', 'island', 'forest', 'desert', 'cave', 'cactus', 'sunflower', 'acorn', 'seashell'],
    hard: ['canyon', 'glacier', 'coral reef', 'tornado', 'lightning', 'snowflake'],
  },
  transport: {
    easy: ['car', 'bus', 'train', 'bicycle', 'boat', 'truck', 'taxi', 'motorcycle', 'airplane'],
    medium: ['helicopter', 'sailboat', 'submarine', 'tractor', 'ambulance', 'skateboard', 'canoe', 'ferry', 'tram', 'snowmobile', 'fire engine'],
    hard: ['hot air balloon', 'unicycle', 'horse carriage', 'rocket', 'scooter'],
  },
  activities: {
    easy: ['swimming', 'dancing', 'painting', 'cooking', 'reading', 'singing', 'soccer', 'fishing', 'camping'],
    medium: ['juggling', 'skating', 'skiing', 'surfing', 'climbing', 'gardening', 'writing', 'bowling', 'basketball', 'tennis'],
    hard: ['archery', 'kite flying', 'roller skating', 'horseback riding', 'drumming', 'yoga'],
  },
  places: {
    easy: ['house', 'school', 'library', 'park', 'zoo', 'barn', 'bakery', 'market', 'castle'],
    medium: ['airport', 'hospital', 'museum', 'stadium', 'lighthouse', 'theater', 'temple', 'train station', 'aquarium'],
    hard: ['pyramid', 'windmill', 'factory', 'playground', 'campsite', 'space station', 'skyscraper'],
  },
  abstract: {
    easy: ['love', 'peace', 'friendship', 'dream', 'luck', 'music', 'hope', 'surprise', 'teamwork'],
    medium: ['time', 'memory', 'courage', 'secret', 'idea', 'silence', 'freedom', 'balance', 'patience', 'fear'],
    hard: ['justice', 'gravity', 'echo', 'puzzle', 'chaos', 'infinity'],
  },
});

export function normalizeWord(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ')
    : '';
}

export function validateWordBank(entries) {
  const errors = [];
  if (!Array.isArray(entries)) return ['Word bank must be an array.'];
  const seen = new Set();
  const categories = new Set(Object.keys(WORD_GROUPS));
  const difficulties = new Set(['easy', 'medium', 'hard']);
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      errors.push(`Entry ${index} must be an object.`);
      return;
    }
    const word = normalizeWord(entry.word);
    if (word.length < 2 || word.length > 40 || !/^[\p{L}\p{N}]+(?:[ -][\p{L}\p{N}]+)*$/u.test(word)) {
      errors.push(`Entry ${index} has an invalid word.`);
    }
    if (!categories.has(entry.category)) errors.push(`Entry ${index} has an invalid category.`);
    if (!difficulties.has(entry.difficulty)) errors.push(`Entry ${index} has an invalid difficulty.`);
    if (seen.has(word)) errors.push(`Entry ${index} duplicates a normalized word.`);
    seen.add(word);
  });
  return errors;
}

export const WORD_BANK = Object.freeze(Object.entries(WORD_GROUPS).flatMap(([category, levels]) =>
  Object.entries(levels).flatMap(([difficulty, words]) => words.map((word) => Object.freeze({ word, category, difficulty }))),
));

export { WORD_GROUPS };
