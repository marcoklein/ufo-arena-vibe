// Visual identity for the rooms. A level is a mix of chambers, and each one is
// dressed in one of these themes so that it is recognisable from a distance:
// the walls lining a themed room are tinted, its crown trim glows in the theme
// colour, the floor carries a glowing pad, and a few walls sprout a prop.
//
// Purely cosmetic data, shared by maze.js (which assigns a theme to each room)
// and main.js (which builds the geometry). No Three.js import here.

export const THEMES = [
  {
    id: "core",
    name: "Core",
    wall: 0x415a72,   // tint applied to the walls lining the room
    trim: 0x49b8ff,   // glowing crown trim on top of them
    pad: 0x3f8fdd,    // floor pad colour
    prop: 0x9fdcff,   // emissive colour of the wall props
    kind: "beacon",
  },
  {
    id: "ember",
    name: "Ember",
    wall: 0x6b4030,
    trim: 0xff7a2f,
    pad: 0xc2551f,
    prop: 0xffb066,
    kind: "crystal",
  },
  {
    id: "frost",
    name: "Frost",
    wall: 0x3d5c6b,
    trim: 0x9fe8ff,
    pad: 0x5fb6de,
    prop: 0xd8f6ff,
    kind: "crystal",
  },
  {
    id: "toxic",
    name: "Toxic",
    wall: 0x36543c,
    trim: 0x76ff9a,
    pad: 0x3fae62,
    prop: 0xb6ffc8,
    kind: "vent",
  },
  {
    id: "violet",
    name: "Violet",
    wall: 0x473d68,
    trim: 0xa98bff,
    pad: 0x7a5ed6,
    prop: 0xd8c8ff,
    kind: "beacon",
  },
  {
    id: "rust",
    name: "Rust",
    wall: 0x5c4834,
    trim: 0xffc06a,
    pad: 0xb08244,
    prop: 0xffdc9e,
    kind: "vent",
  },
];

export const THEME_BY_ID = Object.fromEntries(THEMES.map((t, i) => [t.id, i]));
