# Five-session multiplayer API test

- Run: 2026-10-11T09:44:31.780Z
- Node: v24.14.0
- Fixture port: 56630
- Server: copied from current V2 `server.js` into a temporary directory; no source patching.
- Data: synthetic salts/PINs and a temporary `.blocky-world-data` directory; no family world or credentials used.
- Sessions: five independently authenticated page/cookie pairs across p1, p2, p3. This tests five sessions; it does not assert five simultaneous admitted world players.

## Scenario results

1. **PASS** five concurrent login attempts across two repeated profile IDs produced five distinct session cookies after retrying any 429; no profile was added.
2. **PASS** parallel logins do not invalidate earlier cookies: all five page-scoped sessions remain authenticated.
3. **PASS** a second authenticated session for p1 is rejected as a duplicate host; the original room remains active.
4. **PASS** three simultaneous visitor requests race for one slot: one receives 202 Accepted and two receive 409 Conflict.
5. **PASS** only the accepted session’s movement is relayed; both excess sessions receive `state: none`, and their attempted edit is absent from the owner save. The accepted visitor edit is present.
6. **PASS** after request contention, Fight role choices are limited to the approved pair; a loser gets 409 and accepted visitor controls propagate to the host.
7. **PASS** accepted visitor leave frees capacity; a second profile can reconnect; host stop closes it; the same authenticated guest can request again after host reopen and still receives the visitor Fight role.
8. **PASS** unexpected host silence beyond the 15-second heartbeat timeout closes the visitor session while visitor heartbeats continue.

## HTTP evidence

Bodies below are the exact parsed JSON returned by the copied service. Session labels identify the independent test client; all profile PIN values were synthetic.

### p1-host-current: POST /api/login → 429

```json
{
  "error": "Another sign-in check is running. Wait a moment and try again."
}
```

### p1-host-old: POST /api/login → 200

```json
{
  "ok": true,
  "user": {
    "id": "p1",
    "displayName": "Florenz"
  }
}
```

### p2-visitor-b: POST /api/login → 429

```json
{
  "error": "Another sign-in check is running. Wait a moment and try again."
}
```

### p2-visitor-a: POST /api/login → 200

```json
{
  "ok": true,
  "user": {
    "id": "p2",
    "displayName": "Marlene"
  }
}
```

### p1-host-current-retry: POST /api/login → 200

```json
{
  "ok": true,
  "user": {
    "id": "p1",
    "displayName": "Florenz"
  }
}
```

### p2-visitor-b-retry: POST /api/login → 200

```json
{
  "ok": true,
  "user": {
    "id": "p2",
    "displayName": "Marlene"
  }
}
```

### p3-spare: POST /api/login → 200

```json
{
  "ok": true,
  "user": {
    "id": "p3",
    "displayName": "Feng"
  }
}
```

### p1-host-old: GET /api/status → 200

```json
{
  "setupRequired": false,
  "profileSetupRequired": false,
  "canAddProfile": true,
  "authenticated": true,
  "profiles": [
    {
      "id": "p1",
      "displayName": "Florenz"
    },
    {
      "id": "p2",
      "displayName": "Marlene"
    },
    {
      "id": "p3",
      "displayName": "Feng"
    }
  ],
  "user": {
    "id": "p1",
    "displayName": "Florenz"
  }
}
```

### p1-host-current-retry: GET /api/status → 200

```json
{
  "setupRequired": false,
  "profileSetupRequired": false,
  "canAddProfile": true,
  "authenticated": true,
  "profiles": [
    {
      "id": "p1",
      "displayName": "Florenz"
    },
    {
      "id": "p2",
      "displayName": "Marlene"
    },
    {
      "id": "p3",
      "displayName": "Feng"
    }
  ],
  "user": {
    "id": "p1",
    "displayName": "Florenz"
  }
}
```

### p2-visitor-a: GET /api/status → 200

```json
{
  "setupRequired": false,
  "profileSetupRequired": false,
  "canAddProfile": true,
  "authenticated": true,
  "profiles": [
    {
      "id": "p1",
      "displayName": "Florenz"
    },
    {
      "id": "p2",
      "displayName": "Marlene"
    },
    {
      "id": "p3",
      "displayName": "Feng"
    }
  ],
  "user": {
    "id": "p2",
    "displayName": "Marlene"
  }
}
```

### p2-visitor-b-retry: GET /api/status → 200

```json
{
  "setupRequired": false,
  "profileSetupRequired": false,
  "canAddProfile": true,
  "authenticated": true,
  "profiles": [
    {
      "id": "p1",
      "displayName": "Florenz"
    },
    {
      "id": "p2",
      "displayName": "Marlene"
    },
    {
      "id": "p3",
      "displayName": "Feng"
    }
  ],
  "user": {
    "id": "p2",
    "displayName": "Marlene"
  }
}
```

### p3-spare: GET /api/status → 200

```json
{
  "setupRequired": false,
  "profileSetupRequired": false,
  "canAddProfile": true,
  "authenticated": true,
  "profiles": [
    {
      "id": "p1",
      "displayName": "Florenz"
    },
    {
      "id": "p2",
      "displayName": "Marlene"
    },
    {
      "id": "p3",
      "displayName": "Feng"
    }
  ],
  "user": {
    "id": "p3",
    "displayName": "Feng"
  }
}
```

### p1-host-old: POST /api/visit/host → 201

```json
{
  "ok": true,
  "ownerId": "p1",
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ]
}
```

### p1-host-current-retry: POST /api/visit/host → 409

```json
{
  "error": "This profile is already hosting from another device. Stop hosting there first."
}
```

### p1-host-old: POST /api/visit/sync → 200

```json
{
  "state": "hosting",
  "role": "owner",
  "cursor": 0,
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 0,
  "pending": null,
  "remotePlayer": null,
  "fightInput": null,
  "fightState": null,
  "events": []
}
```

### p1-host-old: GET /api/visits → 200

```json
{
  "owners": []
}
```

### p2-visitor-a: POST /api/visit/request → 202

```json
{
  "ok": true,
  "ownerName": "Florenz"
}
```

### p2-visitor-b-retry: POST /api/visit/request → 409

```json
{
  "error": "That world already has a visitor request or guest."
}
```

### p3-spare: POST /api/visit/request → 409

```json
{
  "error": "That world already has a visitor request or guest."
}
```

### p1-host-old: POST /api/visit/sync → 200

```json
{
  "state": "hosting",
  "role": "owner",
  "cursor": 0,
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 0,
  "pending": {
    "id": "pcrZSIw5A5elb6qW",
    "displayName": "Marlene"
  },
  "remotePlayer": null,
  "fightInput": null,
  "fightState": null,
  "events": []
}
```

### p1-host-old: POST /api/visit/respond → 200

```json
{
  "ok": true,
  "approved": true
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 1,
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 0,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853638
  },
  "fightInput": null,
  "fightState": null,
  "events": [
    {
      "seq": 1,
      "type": "joined",
      "data": {
        "displayName": "Marlene"
      }
    }
  ],
  "world": {
    "version": 2,
    "worldType": "normal",
    "revision": 0,
    "seed": 1337,
    "player1": null,
    "slot": 0,
    "pick": null,
    "settings": null,
    "inventory": {
      "apple": 0,
      "meat": 0
    },
    "edits": []
  },
  "ownerName": "Florenz"
}
```

### p2-visitor-b-retry: POST /api/visit/sync → 200

```json
{
  "state": "none"
}
```

### p3-spare: POST /api/visit/sync → 200

```json
{
  "state": "none"
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 1,
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 0,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853638
  },
  "fightInput": null,
  "fightState": null,
  "events": []
}
```

### p1-host-old: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "owner",
  "cursor": 1,
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 0,
  "pending": null,
  "remotePlayer": {
    "pos": [
      103,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853643
  },
  "fightInput": null,
  "fightState": null,
  "events": []
}
```

### p1-host-old: GET /api/world → 200

```json
{
  "ownerId": "p1",
  "world": {
    "version": 2,
    "worldType": "normal",
    "revision": 0,
    "seed": 1337,
    "player1": null,
    "slot": 0,
    "pick": null,
    "settings": null,
    "inventory": {
      "apple": 0,
      "meat": 0
    },
    "edits": []
  }
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 2,
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853644
  },
  "fightInput": null,
  "fightState": null,
  "events": []
}
```

### p1-host-old: GET /api/world → 200

```json
{
  "ownerId": "p1",
  "world": {
    "version": 2,
    "worldType": "normal",
    "revision": 1,
    "seed": 1337,
    "player1": null,
    "slot": 0,
    "pick": null,
    "settings": null,
    "inventory": {
      "apple": 0,
      "meat": 0
    },
    "edits": [
      [
        101,
        10,
        100,
        4
      ]
    ]
  }
}
```

### p1-host-old: POST /api/visit/mode → 200

```json
{
  "ok": true,
  "mode": "fight",
  "modeRevision": 1
}
```

### p1-host-old: POST /api/visit/fight-choice → 200

```json
{
  "ok": true,
  "choice": null,
  "votes": {
    "owner": "duel",
    "visitor": null
  },
  "phase": "setup"
}
```

### p2-visitor-a: POST /api/visit/fight-choice → 200

```json
{
  "ok": true,
  "choice": null,
  "votes": {
    "owner": "duel",
    "visitor": "coop"
  },
  "phase": "setup"
}
```

### p2-visitor-b-retry: POST /api/visit/fight-choice → 409

```json
{
  "error": "Fight Arena is not active for this visit."
}
```

### p2-visitor-a: POST /api/visit/fight-choice → 200

```json
{
  "ok": true,
  "choice": "duel",
  "votes": {
    "owner": "duel",
    "visitor": "duel"
  },
  "phase": "active"
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 4,
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": "duel",
  "fightVotes": {
    "owner": "duel",
    "visitor": "duel"
  },
  "fightPhase": "active",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853644
  },
  "fightInput": null,
  "fightState": null,
  "events": [
    {
      "seq": 1,
      "type": "joined",
      "data": {
        "displayName": "Marlene"
      }
    }
  ]
}
```

### p1-host-old: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "owner",
  "cursor": 4,
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": "duel",
  "fightVotes": {
    "owner": "duel",
    "visitor": "duel"
  },
  "fightPhase": "active",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      103,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853646
  },
  "fightInput": {
    "mx": 0.5,
    "mz": 0,
    "turn": 0,
    "yaw": 0.3,
    "jump": true,
    "sneak": false,
    "actions": {
      "attack": 1,
      "special": 0,
      "ult": 0,
      "altAttack": 0
    }
  },
  "fightState": null,
  "events": [
    {
      "seq": 2,
      "type": "edit",
      "data": [
        101,
        10,
        100,
        4
      ]
    },
    {
      "seq": 3,
      "type": "fight-start",
      "data": {
        "choice": "duel"
      }
    },
    {
      "seq": 4,
      "type": "fight-action",
      "data": {
        "role": "visitor",
        "action": "attack",
        "seq": 1
      }
    }
  ]
}
```

### p2-visitor-a: POST /api/visit/leave → 200

```json
{
  "ok": true
}
```

### p1-host-old: POST /api/visit/sync → 200

```json
{
  "state": "hosting",
  "role": "owner",
  "cursor": 5,
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": "duel",
  "fightVotes": {
    "owner": "duel",
    "visitor": "duel"
  },
  "fightPhase": "active",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": null,
  "fightInput": {
    "mx": 0.5,
    "mz": 0,
    "turn": 0,
    "yaw": 0.3,
    "jump": true,
    "sneak": false,
    "actions": {
      "attack": 1,
      "special": 0,
      "ult": 0,
      "altAttack": 0
    }
  },
  "fightState": null,
  "events": [
    {
      "seq": 2,
      "type": "edit",
      "data": [
        101,
        10,
        100,
        4
      ]
    },
    {
      "seq": 3,
      "type": "fight-start",
      "data": {
        "choice": "duel"
      }
    },
    {
      "seq": 4,
      "type": "fight-action",
      "data": {
        "role": "visitor",
        "action": "attack",
        "seq": 1
      }
    },
    {
      "seq": 5,
      "type": "left",
      "data": {
        "displayName": "Marlene"
      }
    }
  ]
}
```

### p3-spare: POST /api/visit/request → 202

```json
{
  "ok": true,
  "ownerName": "Florenz"
}
```

### p1-host-old: POST /api/visit/sync → 200

```json
{
  "state": "hosting",
  "role": "owner",
  "cursor": 5,
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": "duel",
  "fightVotes": {
    "owner": "duel",
    "visitor": "duel"
  },
  "fightPhase": "active",
  "worldRevision": 1,
  "pending": {
    "id": "6hvx72X0l-vVnB0e",
    "displayName": "Feng"
  },
  "remotePlayer": null,
  "fightInput": {
    "mx": 0.5,
    "mz": 0,
    "turn": 0,
    "yaw": 0.3,
    "jump": true,
    "sneak": false,
    "actions": {
      "attack": 1,
      "special": 0,
      "ult": 0,
      "altAttack": 0
    }
  },
  "fightState": null,
  "events": []
}
```

### p1-host-old: POST /api/visit/respond → 200

```json
{
  "ok": true,
  "approved": true
}
```

### p3-spare: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 6,
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": "duel",
  "fightVotes": {
    "owner": "duel",
    "visitor": "duel"
  },
  "fightPhase": "active",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853661
  },
  "fightInput": null,
  "fightState": null,
  "events": [
    {
      "seq": 1,
      "type": "joined",
      "data": {
        "displayName": "Marlene"
      }
    },
    {
      "seq": 2,
      "type": "edit",
      "data": [
        101,
        10,
        100,
        4
      ]
    },
    {
      "seq": 3,
      "type": "fight-start",
      "data": {
        "choice": "duel"
      }
    },
    {
      "seq": 4,
      "type": "fight-action",
      "data": {
        "role": "visitor",
        "action": "attack",
        "seq": 1
      }
    },
    {
      "seq": 5,
      "type": "left",
      "data": {
        "displayName": "Marlene"
      }
    },
    {
      "seq": 6,
      "type": "joined",
      "data": {
        "displayName": "Feng"
      }
    }
  ],
  "world": {
    "version": 2,
    "worldType": "normal",
    "revision": 1,
    "seed": 1337,
    "player1": null,
    "slot": 0,
    "pick": null,
    "settings": null,
    "inventory": {
      "apple": 0,
      "meat": 0
    },
    "edits": [
      [
        101,
        10,
        100,
        4
      ]
    ]
  },
  "ownerName": "Florenz"
}
```

### p1-host-old: POST /api/visit/stop → 200

```json
{
  "ok": true
}
```

### p3-spare: POST /api/visit/sync → 200

```json
{
  "state": "closed",
  "reason": "The host ended the live visit."
}
```

### p1-host-old: POST /api/visit/host → 201

```json
{
  "ok": true,
  "ownerId": "p1",
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ]
}
```

### p3-spare: POST /api/visit/request → 202

```json
{
  "ok": true,
  "ownerName": "Florenz"
}
```

### p1-host-old: POST /api/visit/sync → 200

```json
{
  "state": "hosting",
  "role": "owner",
  "cursor": 0,
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 1,
  "pending": {
    "id": "i5xrUL5EUGQAdQRu",
    "displayName": "Feng"
  },
  "remotePlayer": null,
  "fightInput": null,
  "fightState": null,
  "events": []
}
```

### p1-host-old: POST /api/visit/respond → 200

```json
{
  "ok": true,
  "approved": true
}
```

### p3-spare: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 1,
  "mode": "fight",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853669
  },
  "fightInput": null,
  "fightState": null,
  "events": [
    {
      "seq": 1,
      "type": "joined",
      "data": {
        "displayName": "Feng"
      }
    }
  ],
  "world": {
    "version": 2,
    "worldType": "normal",
    "revision": 1,
    "seed": 1337,
    "player1": null,
    "slot": 0,
    "pick": null,
    "settings": null,
    "inventory": {
      "apple": 0,
      "meat": 0
    },
    "edits": [
      [
        101,
        10,
        100,
        4
      ]
    ]
  },
  "ownerName": "Florenz"
}
```

### p1-host-old: POST /api/visit/mode → 200

```json
{
  "ok": true,
  "mode": "fight",
  "modeRevision": 1
}
```

### p1-host-old: POST /api/visit/fight-choice → 200

```json
{
  "ok": true,
  "choice": null,
  "votes": {
    "owner": "coop",
    "visitor": null
  },
  "phase": "setup"
}
```

### p3-spare: POST /api/visit/fight-choice → 200

```json
{
  "ok": true,
  "choice": "coop",
  "votes": {
    "owner": "coop",
    "visitor": "coop"
  },
  "phase": "active"
}
```

### p1-host-old: POST /api/visit/stop → 200

```json
{
  "ok": true
}
```

### p1-host-old: POST /api/visit/host → 201

```json
{
  "ok": true,
  "ownerId": "p1",
  "mode": "play",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ]
}
```

### p2-visitor-a: POST /api/visit/request → 202

```json
{
  "ok": true,
  "ownerName": "Florenz"
}
```

### p1-host-old: POST /api/visit/sync → 200

```json
{
  "state": "hosting",
  "role": "owner",
  "cursor": 0,
  "mode": "play",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 1,
  "pending": {
    "id": "ae8emGqeqJs-lmL8",
    "displayName": "Marlene"
  },
  "remotePlayer": null,
  "fightInput": null,
  "fightState": null,
  "events": []
}
```

### p1-host-old: POST /api/visit/respond → 200

```json
{
  "ok": true,
  "approved": true
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 1,
  "mode": "play",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853678
  },
  "fightInput": null,
  "fightState": null,
  "events": [
    {
      "seq": 1,
      "type": "joined",
      "data": {
        "displayName": "Marlene"
      }
    }
  ],
  "world": {
    "version": 2,
    "worldType": "normal",
    "revision": 1,
    "seed": 1337,
    "player1": null,
    "slot": 0,
    "pick": null,
    "settings": null,
    "inventory": {
      "apple": 0,
      "meat": 0
    },
    "edits": [
      [
        101,
        10,
        100,
        4
      ]
    ]
  },
  "ownerName": "Florenz"
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 1,
  "mode": "play",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853678
  },
  "fightInput": null,
  "fightState": null,
  "events": [
    {
      "seq": 1,
      "type": "joined",
      "data": {
        "displayName": "Marlene"
      }
    }
  ]
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 1,
  "mode": "play",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853678
  },
  "fightInput": null,
  "fightState": null,
  "events": [
    {
      "seq": 1,
      "type": "joined",
      "data": {
        "displayName": "Marlene"
      }
    }
  ]
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 1,
  "mode": "play",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853678
  },
  "fightInput": null,
  "fightState": null,
  "events": [
    {
      "seq": 1,
      "type": "joined",
      "data": {
        "displayName": "Marlene"
      }
    }
  ]
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 1,
  "mode": "play",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853678
  },
  "fightInput": null,
  "fightState": null,
  "events": [
    {
      "seq": 1,
      "type": "joined",
      "data": {
        "displayName": "Marlene"
      }
    }
  ]
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 1,
  "mode": "play",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853678
  },
  "fightInput": null,
  "fightState": null,
  "events": [
    {
      "seq": 1,
      "type": "joined",
      "data": {
        "displayName": "Marlene"
      }
    }
  ]
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 1,
  "mode": "play",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853678
  },
  "fightInput": null,
  "fightState": null,
  "events": [
    {
      "seq": 1,
      "type": "joined",
      "data": {
        "displayName": "Marlene"
      }
    }
  ]
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 1,
  "mode": "play",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853678
  },
  "fightInput": null,
  "fightState": null,
  "events": [
    {
      "seq": 1,
      "type": "joined",
      "data": {
        "displayName": "Marlene"
      }
    }
  ]
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "active",
  "role": "visitor",
  "cursor": 1,
  "mode": "play",
  "modeRevision": 1,
  "arenaCenter": [
    100008,
    100008
  ],
  "fightChoice": null,
  "fightVotes": {
    "owner": null,
    "visitor": null
  },
  "fightPhase": "setup",
  "worldRevision": 1,
  "pending": null,
  "remotePlayer": {
    "pos": [
      100,
      20,
      100
    ],
    "yaw": 0,
    "pitch": 0,
    "characterId": "steve",
    "playAttackSeq": 0,
    "playAttackDamage": 8,
    "updatedAt": 1791711853678
  },
  "fightInput": null,
  "fightState": null,
  "events": [
    {
      "seq": 1,
      "type": "joined",
      "data": {
        "displayName": "Marlene"
      }
    }
  ]
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "closed",
  "reason": "The host disconnected."
}
```

### p2-visitor-a: POST /api/visit/sync → 200

```json
{
  "state": "closed",
  "reason": "The host disconnected."
}
```

## Cleanup

Disposable server process stopped; its temp fixture and synthetic world/account files were removed. No configured service or profile data was opened.
