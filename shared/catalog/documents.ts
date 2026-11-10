// Recoverable documents (original lore). Each facility seeds a few into its rooms.
import type { MapId } from './maps';

export interface DocumentDef { id: string; map: Exclude<MapId, 'practice'> | 'any'; title: string; body: string }

export const DOCUMENTS: DocumentDef[] = [
  { id: 'r1', map: 'research', title: 'Incident memo 14-C', body: 'All staff: the sub-level freezers are NOT to be opened outside of scheduled audits. Whatever you hear in there is the compressor. Report anything else to Dr. Anand directly, not to Security.' },
  { id: 'r2', map: 'research', title: 'Lab notebook, page 212', body: 'Subject responded to our recorded voices before playback started. Third time this week. I have asked for the audio rig to be moved out of Lab 4. Nobody will tell me who signed for it.' },
  { id: 'r3', map: 'research', title: 'Facilities ticket #9921', body: 'Fluorescents in the east corridor keep dying in sequence, back toward the lift. Electrician says the wiring is fine. He refused to finish the job after dark.' },
  { id: 'r4', map: 'research', title: 'Evacuation roster', body: 'Headcount at muster point: 61 of 64. The three missing badges all scanned OUT at 03:12. The lift log shows no departures after 02:40.' },
  { id: 'r5', map: 'research', title: 'Sticky note on a monitor', body: 'DO NOT RUN. It hears running. Walk, and keep your torch on the ceiling.' },
  { id: 'i1', map: 'industrial', title: 'Shift supervisor log', body: 'Line 3 stopped again. Found the press operator sitting under the conveyor with his ears covered. Says the big one walks the warehouse at night and knocks the crates over to hear them fall.' },
  { id: 'i2', map: 'industrial', title: 'Maintenance schedule', body: 'Steam mains in the boiler hall vent automatically every few minutes. Mind the pressure gauges and stay clear when the pipes start knocking.' },
  { id: 'i3', map: 'industrial', title: 'Union notice', body: 'Until management explains the "noise complaints", no member is required to work alone on the night shift. Buddy system is mandatory. This is not a request.' },
  { id: 'i4', map: 'industrial', title: 'Torn requisition', body: '...replacement doors for loading bay 2 (third set this month). Hinges sheared, frame bent INWARD. Recommend steel. Recommend leaving.' },
  { id: 'u1', map: 'underground', title: 'Site 9 standing orders', body: 'Generators are to be kept running at all times. Under no circumstances is any sector to be left dark for more than ten minutes. The reasons for this order are classified.' },
  { id: 'u2', map: 'underground', title: 'Radio transcript', body: '"...say again, Depth Two, we have movement on the ceiling of the pump room." "Negative, Depth Two, there is nothing in the pump room. Hold position." [static]' },
  { id: 'u3', map: 'underground', title: 'Scratched into a bunk', body: 'they come in packs when its quiet. bang something. bang anything.' },
  { id: 'u4', map: 'underground', title: 'Quartermaster ledger', body: 'Strongroom inventory sealed by order of the commandant. Keycard held by the duty officer. The duty officer has not been seen since the flooding on level two.' },
  { id: 'l1', map: 'luxury', title: 'Guest complaint', body: 'Room 214 heard someone pacing in the corridor all night, stopping outside each door in turn. The night manager insists there were no other guests on that floor.' },
  { id: 'l2', map: 'luxury', title: 'Auction catalogue (annotated)', body: 'Lot 88, "The Weeping Saint". Provenance unclear. Three previous owners deceased. Handwritten: DO NOT MOVE IT FROM THE GALLERY.' },
  { id: 'l3', map: 'luxury', title: 'Housekeeping note', body: 'The lenses in the chandelier hall moved again. I do not mean the crystals. I stood very still until it turned away. Do not look up and walk at the same time.' },
  { id: 'l4', map: 'luxury', title: 'Telegram', body: 'CLOSING HOTEL STOP LEAVE EVERYTHING STOP DO NOT COLLECT THE ART STOP SOMEONE WILL COME FOR IT EVENTUALLY STOP' },
  { id: 'g1', map: 'any', title: 'Greyline Recovery: crew handbook p.3', body: 'Remember: the quota is the minimum, not the goal. The goal is coming home. A crew that comes home can work again tomorrow.' },
  { id: 'g2', map: 'any', title: 'Greyline Recovery: crew handbook p.9', body: 'If you hear a crewmate call from somewhere they cannot be, they are not there. Do not answer. Do not go to them.' },
  { id: 'g3', map: 'any', title: 'Previous crew\'s note', body: 'Stayed past the window to grab one more statue. Heard the lift bell ring by itself. Something tall standing in the cargo bay. Didn\'t look at it. Left the statue.' },
];

export const DOCUMENT_BY_ID: Record<string, DocumentDef> = Object.fromEntries(DOCUMENTS.map((d) => [d.id, d]));
