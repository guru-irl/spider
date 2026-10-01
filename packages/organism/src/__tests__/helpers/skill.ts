export function finalSkillBody(name: string, instructions = "Trace each asynchronous writer and verify the final writer closes its output before reading it."): string {
  return `---\nname: ${name}\ndescription: Use when asynchronous writes need completion evidence\n---\n# Writer ownership\n${instructions}`;
}

export const newSkillReview = { reviewer: async (): Promise<string> => '{"verdict":"new","reason":"a reusable technique"}' };
