/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/basira.json`.
 */
export type Basira = {
  "address": "2oYHgAYscSG4JvQcKcUq4oFGsDFU2SRBtFYFnHxpzgtu",
  "metadata": {
    "name": "basira",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "executeIntent",
      "docs": [
        "Execute an approved intent. For Transfer, performs a real SystemProgram",
        "CPI from the agent's vault PDA to the approved recipient. The receipt",
        "is only written if the inner action succeeds."
      ],
      "discriminator": [
        53,
        130,
        47,
        154,
        227,
        220,
        122,
        212
      ],
      "accounts": [
        {
          "name": "intentRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agentAccount"
              },
              {
                "kind": "account",
                "path": "intent_request.seq",
                "account": "intentRequest"
              }
            ]
          }
        },
        {
          "name": "agent",
          "relations": [
            "intentRequest"
          ]
        },
        {
          "name": "agentAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agentAccount"
              }
            ]
          }
        },
        {
          "name": "recipient",
          "writable": true
        },
        {
          "name": "executionReceipt",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  99,
                  101,
                  105,
                  112,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agentAccount"
              },
              {
                "kind": "account",
                "path": "intent_request.seq",
                "account": "intentRequest"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "agentAccount"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "registerAgent",
      "docs": [
        "Register a new agent and its PolicyAccount with an initial rule list."
      ],
      "discriminator": [
        135,
        157,
        66,
        195,
        2,
        113,
        175,
        30
      ],
      "accounts": [
        {
          "name": "agentAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "policyAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "agentAccount"
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "derived from `agent_account` here so we can capture and store its bump",
            "at registration time; it holds no data."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agentAccount"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "rules",
          "type": {
            "vec": {
              "defined": {
                "name": "rule"
              }
            }
          }
        },
        {
          "name": "policyAuthority",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    },
    {
      "name": "replacePolicy",
      "docs": [
        "Replace the agent's rule list. Must be signed by `policy_authority`.",
        "Resets all rate-limit window counters (a fresh policy applies from `now`)."
      ],
      "discriminator": [
        69,
        201,
        103,
        104,
        70,
        72,
        85,
        29
      ],
      "accounts": [
        {
          "name": "agentAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agent_account.authority",
                "account": "agentAccount"
              }
            ]
          }
        },
        {
          "name": "policyAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "agentAccount"
              }
            ]
          }
        },
        {
          "name": "policyAuthority",
          "signer": true,
          "relations": [
            "agentAccount"
          ]
        }
      ],
      "args": [
        {
          "name": "rules",
          "type": {
            "vec": {
              "defined": {
                "name": "rule"
              }
            }
          }
        }
      ]
    },
    {
      "name": "submitIntent",
      "docs": [
        "Submit an intent. The interpreter iterates the agent's rule list;",
        "the first failing rule rejects with `rule N: <reason>`."
      ],
      "discriminator": [
        159,
        255,
        153,
        9,
        149,
        139,
        73,
        112
      ],
      "accounts": [
        {
          "name": "agentAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "policyAccount",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "agentAccount"
              }
            ]
          }
        },
        {
          "name": "intentRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agentAccount"
              },
              {
                "kind": "account",
                "path": "agent_account.intent_count",
                "account": "agentAccount"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "agentAccount"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "actionType",
          "type": {
            "defined": {
              "name": "actionType"
            }
          }
        },
        {
          "name": "valueLamports",
          "type": "u64"
        },
        {
          "name": "recipient",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "agentAccount",
      "discriminator": [
        241,
        119,
        69,
        140,
        233,
        9,
        112,
        50
      ]
    },
    {
      "name": "executionReceipt",
      "discriminator": [
        126,
        220,
        166,
        135,
        248,
        208,
        202,
        171
      ]
    },
    {
      "name": "intentRequest",
      "discriminator": [
        32,
        121,
        199,
        250,
        8,
        115,
        193,
        172
      ]
    },
    {
      "name": "policyAccount",
      "discriminator": [
        218,
        201,
        183,
        164,
        156,
        127,
        81,
        175
      ]
    }
  ],
  "events": [
    {
      "name": "agentRegistered",
      "discriminator": [
        191,
        78,
        217,
        54,
        232,
        100,
        189,
        85
      ]
    },
    {
      "name": "intentEvaluated",
      "discriminator": [
        55,
        137,
        211,
        70,
        235,
        90,
        79,
        191
      ]
    },
    {
      "name": "policyReplaced",
      "discriminator": [
        211,
        79,
        114,
        239,
        123,
        167,
        221,
        4
      ]
    },
    {
      "name": "receiptWritten",
      "discriminator": [
        9,
        133,
        147,
        207,
        28,
        99,
        77,
        199
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "intentNotApproved",
      "msg": "Intent has not been approved"
    },
    {
      "code": 6001,
      "name": "intentAlreadyFinalised",
      "msg": "Intent already finalised"
    },
    {
      "code": 6002,
      "name": "unauthorizedPolicyUpdate",
      "msg": "Signer is not the policy authority"
    },
    {
      "code": 6003,
      "name": "unsupportedActionCpi",
      "msg": "Action type not yet supported for on-chain execution"
    },
    {
      "code": 6004,
      "name": "recipientRequired",
      "msg": "Transfer intents require a recipient"
    },
    {
      "code": 6005,
      "name": "recipientMismatch",
      "msg": "Recipient account does not match the approved intent"
    },
    {
      "code": 6006,
      "name": "emptyPolicy",
      "msg": "Policy rule list is empty"
    },
    {
      "code": 6007,
      "name": "tooManyRules",
      "msg": "Policy rule list exceeds the maximum allowed length"
    },
    {
      "code": 6008,
      "name": "tooManyRateWindows",
      "msg": "Policy contains more RatePerWindow rules than supported"
    },
    {
      "code": 6009,
      "name": "nameTooLong",
      "msg": "Name exceeds 32 chars"
    }
  ],
  "types": [
    {
      "name": "actionType",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "transfer"
          },
          {
            "name": "swap"
          },
          {
            "name": "stake"
          },
          {
            "name": "contractCall"
          }
        ]
      }
    },
    {
      "name": "agentAccount",
      "docs": [
        "Persistent identity record for a registered agent."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "policyAuthority",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "intentCount",
            "type": "u64"
          },
          {
            "name": "windows",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "windowCounter"
                  }
                },
                4
              ]
            }
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "agentRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "policyAuthority",
            "type": "pubkey"
          },
          {
            "name": "policyVersion",
            "type": "u32"
          },
          {
            "name": "nRules",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "executionReceipt",
      "docs": [
        "Immutable onchain proof that an intent was executed."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "intentSeq",
            "type": "u64"
          },
          {
            "name": "actionType",
            "type": {
              "defined": {
                "name": "actionType"
              }
            }
          },
          {
            "name": "valueLamports",
            "type": "u64"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "executedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "intentEvaluated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "seq",
            "type": "u64"
          },
          {
            "name": "approved",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "intentRequest",
      "docs": [
        "A single proposed action, evaluated against the agent's policy."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "actionType",
            "type": {
              "defined": {
                "name": "actionType"
              }
            }
          },
          {
            "name": "valueLamports",
            "type": "u64"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "intentStatus"
              }
            }
          },
          {
            "name": "rejectionReason",
            "type": {
              "option": "string"
            }
          },
          {
            "name": "submittedAt",
            "type": "i64"
          },
          {
            "name": "finalisedAt",
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "seq",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "intentStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pending"
          },
          {
            "name": "approved"
          },
          {
            "name": "rejected"
          },
          {
            "name": "executed"
          }
        ]
      }
    },
    {
      "name": "policyAccount",
      "docs": [
        "Per-agent policy account holding the user-composed rule list."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "version",
            "type": "u32"
          },
          {
            "name": "rules",
            "type": {
              "vec": {
                "defined": {
                  "name": "rule"
                }
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "policyReplaced",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "version",
            "type": "u32"
          },
          {
            "name": "nRules",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "receiptWritten",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "intentSeq",
            "type": "u64"
          },
          {
            "name": "valueLamports",
            "type": "u64"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "executedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "rule",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "maxValue",
            "fields": [
              {
                "name": "lamports",
                "type": "u64"
              }
            ]
          },
          {
            "name": "allowedActions",
            "fields": [
              {
                "name": "mask",
                "type": "u8"
              }
            ]
          },
          {
            "name": "ratePerWindow",
            "fields": [
              {
                "name": "windowSeconds",
                "type": "i64"
              },
              {
                "name": "max",
                "type": "u32"
              }
            ]
          }
        ]
      }
    },
    {
      "name": "windowCounter",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "startTs",
            "type": "i64"
          },
          {
            "name": "count",
            "type": "u32"
          },
          {
            "name": "ruleIndex",
            "type": "u8"
          },
          {
            "name": "active",
            "type": "bool"
          }
        ]
      }
    }
  ]
};
