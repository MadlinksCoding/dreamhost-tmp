/// July 01 2025
/// DynamoDB/Alternator Schema
/// This file defines the schema for the DynamoDB tables used in the application.

export const user_blocks_schema = {
	TableName: "user_blocks",
	AttributeDefinitions: [
		{ AttributeName: "gpk", AttributeType: "S" },
		{ AttributeName: "blocker_id", AttributeType: "S" },
		{ AttributeName: "sk_scope", AttributeType: "S" },
		{ AttributeName: "blocked_id", AttributeType: "S" },
		{ AttributeName: "scope", AttributeType: "S" },
		{ AttributeName: "is_permanent", AttributeType: "N" },
		{ AttributeName: "created_at", AttributeType: "N" },
		{ AttributeName: "updated_at", AttributeType: "N" },
		{ AttributeName: "id", AttributeType: "S" }
	],
	KeySchema: [
		{ AttributeName: "blocker_id", KeyType: "HASH" },
		{ AttributeName: "sk_scope", KeyType: "RANGE" }
	],
	ProvisionedThroughput: {
		ReadCapacityUnits: 40000,
		WriteCapacityUnits: 40000
	},
	GlobalSecondaryIndexes: [
		{
			IndexName: "blockee_id-scope-index",
			KeySchema: [
				{ AttributeName: "blocker_id", KeyType: "HASH" },
				{ AttributeName: "scope", KeyType: "RANGE" }
			],
			Projection: { ProjectionType: "ALL" },
			ProvisionedThroughput: {
				ReadCapacityUnits: 40000,
				WriteCapacityUnits: 40000
			}
		},
		   {
			   IndexName: "blocked_id-scope-index",
			   KeySchema: [
				   { AttributeName: "blocked_id", KeyType: "HASH" },
				   { AttributeName: "scope", KeyType: "RANGE" }
			   ],
			   Projection: { ProjectionType: "ALL" },
			   ProvisionedThroughput: {
				   ReadCapacityUnits: 40000,
				   WriteCapacityUnits: 40000
			   }
		   },
		   {
			   IndexName: "blocked_id--isperm-index",
			   KeySchema: [
				   { AttributeName: "blocked_id", KeyType: "HASH" },
				   { AttributeName: "is_permanent", KeyType: "RANGE" }
			   ],
			   Projection: { ProjectionType: "ALL" },
			   ProvisionedThroughput: {
				   ReadCapacityUnits: 40000,
				   WriteCapacityUnits: 40000
			   }
		   },
		   {
			   IndexName: "blocked_id-createdat-index",
			   KeySchema: [
				   { AttributeName: "blocked_id", KeyType: "HASH" },
				   { AttributeName: "created_at", KeyType: "RANGE" }
			   ],
			   Projection: { ProjectionType: "ALL" },
			   ProvisionedThroughput: {
				   ReadCapacityUnits: 40000,
				   WriteCapacityUnits: 40000
			   }
		   },
		   {
			   IndexName: "id-index",
			   KeySchema: [
				   { AttributeName: "id", KeyType: "HASH" }
			   ],
			   Projection: { ProjectionType: "ALL" },
			   ProvisionedThroughput: {
				   ReadCapacityUnits: 40000,
				   WriteCapacityUnits: 40000
			   }
		   },
		   {
			   IndexName: "updated_at-index",
			   KeySchema: [
				   { AttributeName: "updated_at", KeyType: "HASH" },
				   { AttributeName: "created_at", KeyType: "RANGE" }
			   ],
			   Projection: { ProjectionType: "ALL" },
			   ProvisionedThroughput: {
				   ReadCapacityUnits: 40000,
				   WriteCapacityUnits: 40000
			   }
		   },
		   {
			   IndexName: "blocker_id-created_at-index",
			   KeySchema: [
				   { AttributeName: "blocker_id", KeyType: "HASH" },
				   { AttributeName: "created_at", KeyType: "RANGE" }
			   ],
			   Projection: { ProjectionType: "ALL" },
			   ProvisionedThroughput: {
				   ReadCapacityUnits: 40000,
				   WriteCapacityUnits: 40000
			   }
		   },
		   {
			   IndexName: "blocker_id-updated_at-index",
			   KeySchema: [
				   { AttributeName: "blocker_id", KeyType: "HASH" },
				   { AttributeName: "updated_at", KeyType: "RANGE" }
			   ],
			   Projection: { ProjectionType: "ALL" },
			   ProvisionedThroughput: {
				   ReadCapacityUnits: 40000,
				   WriteCapacityUnits: 40000
			   }
		   },
		   {
			   IndexName: "global-created_at-index",
			   KeySchema: [
				   { AttributeName: "gpk", KeyType: "HASH" },
				   { AttributeName: "created_at", KeyType: "RANGE" }
			   ],
			   Projection: { ProjectionType: "ALL" },
			   ProvisionedThroughput: {
				   ReadCapacityUnits: 40000,
				   WriteCapacityUnits: 40000
			   }
		   },
		   {
			   IndexName: "global-updated_at-index",
			   KeySchema: [
				   { AttributeName: "gpk", KeyType: "HASH" },
				   { AttributeName: "updated_at", KeyType: "RANGE" }
			   ],
			   Projection: { ProjectionType: "ALL" },
			   ProvisionedThroughput: {
				   ReadCapacityUnits: 40000,
				   WriteCapacityUnits: 40000
			   }
		   }
	],
	// },
	// StreamSpecification: {
	// 	StreamEnabled: boolean,
	// 	StreamViewType: "string",
	// },
	// TableClass: "string",
	// Tags: [
	// 	{
	// 		Key: "string",
	// 		Value: "string",
	// 	},
	// ],
	// WarmThroughput: {
	// 	ReadUnitsPerSecond: number,
	// 	WriteUnitsPerSecond: number,
	// },
};

export const system_blocks_schema = {
	TableName: "system_blocks",
	AttributeDefinitions: [
		{
			AttributeName: "identifier", // identifier is the unique identifier for the block, can be IP, email, or user ID
			AttributeType: "S",
		},
		{
			AttributeName: "sk_type",
			AttributeType: "S",
		},
		{
			AttributeName: "updated_at",
			AttributeType: "N",
		},
		{
			AttributeName: "id",
			AttributeType: "S",
		},
	],
	KeySchema: [
		{
			AttributeName: "identifier",
			KeyType: "HASH",
		},
		{
			AttributeName: "sk_type",
			KeyType: "RANGE",
		},
	],
	//    The commented-out fields below are optional and can be included as needed.
	//
	//    "BillingMode": "string",
	//    "DeletionProtectionEnabled": boolean,
	GlobalSecondaryIndexes: [
		{
			IndexName: "id-index",
			KeySchema: [
				{ AttributeName: "id", KeyType: "HASH" }
			],
			Projection: { ProjectionType: "ALL" },
			ProvisionedThroughput: {
				ReadCapacityUnits: 40000,
				WriteCapacityUnits: 40000
			}
		},
		{
			IndexName: "updated_at-index",
			KeySchema: [
				{ AttributeName: "updated_at", KeyType: "HASH" }
			],
			Projection: { ProjectionType: "ALL" },
			ProvisionedThroughput: {
				ReadCapacityUnits: 40000,
				WriteCapacityUnits: 40000
			}
		}
	],
	// LocalSecondaryIndexes: [
	// 	{
	// 		IndexName: "string",
	// 		KeySchema: [
	// 			{
	// 				AttributeName: "string",
	// 				KeyType: "string",
	// 			},
	// 		],
	// 		Projection: {
	// 			NonKeyAttributes: ["string"],
	// 			ProjectionType: "string",
	// 		},
	// 	},
	// ],
	// OnDemandThroughput: {
	// 	MaxReadRequestUnits: number,
	// 	MaxWriteRequestUnits: number,
	// },
	ProvisionedThroughput: {
		ReadCapacityUnits: 40000,
		WriteCapacityUnits: 40000,
	},
	// ResourcePolicy: "string",
	// SSESpecification: {
	// 	Enabled: boolean,
	// 	KMSMasterKeyId: "string",
	// 	SSEType: "string",
	// },
	// StreamSpecification: {
	// 	StreamEnabled: boolean,
	// 	StreamViewType: "string",
	// },
	// TableClass: "string",
	// Tags: [
	// 	{
	// 		Key: "string",
	// 		Value: "string",
	// 	},
	// ],
	// WarmThroughput: {
	// 	ReadUnitsPerSecond: number,
	// 	WriteUnitsPerSecond: number,
	// },
};

export const manual_actions_schema = {
	TableName: "manual_actions",
	AttributeDefinitions: [
		{
			AttributeName: "user_id", // user_id is the unique identifier for the user on whom the manual action is performed
			AttributeType: "S",
		},
		{
			AttributeName: "sk_ts",
			AttributeType: "S",
		},
		{
			AttributeName: "updated_at",
			AttributeType: "N",
		},
		{
			AttributeName: "id",
			AttributeType: "S",
		},
	],
	KeySchema: [
		{
			AttributeName: "user_id",
			KeyType: "HASH", // Partition key: determines the partition(physical storage) of where the item is stored
		},
		{
			AttributeName: "sk_ts",
			KeyType: "RANGE",
		},
	],
	//    The commented-out fields below are optional and can be included as needed.
	//
	//    "BillingMode": "string",
	//    "DeletionProtectionEnabled": boolean,
	GlobalSecondaryIndexes: [
		{
			IndexName: "id-index",
			KeySchema: [
				{ AttributeName: "id", KeyType: "HASH" }
			],
			Projection: { ProjectionType: "ALL" },
			ProvisionedThroughput: {
				ReadCapacityUnits: 40000,
				WriteCapacityUnits: 40000
			}
		},
		{
			IndexName: "updated_at-index",
			KeySchema: [
				{ AttributeName: "updated_at", KeyType: "HASH" }
			],
			Projection: { ProjectionType: "ALL" },
			ProvisionedThroughput: {
				ReadCapacityUnits: 40000,
				WriteCapacityUnits: 40000
			}
		}
	],
	// LocalSecondaryIndexes: [
	// 	{
	// 		IndexName: "string",
	// 		KeySchema: [
	// 			{
	// 				AttributeName: "string",
	// 				KeyType: "string",
	// 			},
	// 		],
	// 		Projection: {
	// 			NonKeyAttributes: ["string"],
	// 			ProjectionType: "string",
	// 		},
	// 	},
	// ],
	// OnDemandThroughput: {
	// 	MaxReadRequestUnits: number,
	// 	MaxWriteRequestUnits: number,
	// },
	ProvisionedThroughput: {
		ReadCapacityUnits: 40000,
		WriteCapacityUnits: 40000,
	},
	// ResourcePolicy: "string",
	// SSESpecification: {
	// 	Enabled: boolean,
	// 	KMSMasterKeyId: "string",
	// 	SSEType: "string",
	// },
	// StreamSpecification: {
	// 	StreamEnabled: boolean,
	// 	StreamViewType: "string",
	// },
	// TableClass: "string",
	// Tags: [
	// 	{
	// 		Key: "string",
	// 		Value: "string",
	// 	},
	// ],
	// WarmThroughput: {
	// 	ReadUnitsPerSecond: number,
	// 	WriteUnitsPerSecond: number,
	// },
};

export const sample_table_schema = {
	TableName: "user_blocks",
	AttributeDefinitions: [
		{
			AttributeName: "string",
			AttributeType: "S",
		},
	],
	KeySchema: [
		{
			AttributeName: "string",
			KeyType: "string",
		},
	],
	//    The commented-out fields below are optional and can be included as needed.
	//
	//    "BillingMode": "string",
	//    "DeletionProtectionEnabled": boolean,
	//    "GlobalSecondaryIndexes": [
	//       {
	//          "IndexName": "string",
	//          "KeySchema": [
	//             {
	//                "AttributeName": "string",
	//                "KeyType": "string"
	//             }
	//          ],
	//          "OnDemandThroughput": {
	//             "MaxReadRequestUnits": number,
	//             "MaxWriteRequestUnits": number
	//          },
	//          "Projection": {
	//             "NonKeyAttributes": [ "string" ],
	//             "ProjectionType": "string"
	//          },
	//          "ProvisionedThroughput": {
	//             "ReadCapacityUnits": number,
	//             "WriteCapacityUnits": number
	//          },
	//          "WarmThroughput": {
	//             "ReadUnitsPerSecond": number,
	//             "WriteUnitsPerSecond": number
	//          }
	//       }
	//    ],
	// LocalSecondaryIndexes: [
	// 	{
	// 		IndexName: "string",
	// 		KeySchema: [
	// 			{
	// 				AttributeName: "string",
	// 				KeyType: "string",
	// 			},
	// 		],
	// 		Projection: {
	// 			NonKeyAttributes: ["string"],
	// 			ProjectionType: "string",
	// 		},
	// 	},
	// ],
	// OnDemandThroughput: {
	// 	MaxReadRequestUnits: number,
	// 	MaxWriteRequestUnits: number,
	// },
	// ProvisionedThroughput: {
	// 	ReadCapacityUnits: number,
	// 	WriteCapacityUnits: number,
	// },
	// ResourcePolicy: "string",
	// SSESpecification: {
	// 	Enabled: boolean,
	// 	KMSMasterKeyId: "string",
	// 	SSEType: "string",
	// },
	// StreamSpecification: {
	// 	StreamEnabled: boolean,
	// 	StreamViewType: "string",
	// },
	// TableClass: "string",
	// Tags: [
	// 	{
	// 		Key: "string",
	// 		Value: "string",
	// 	},
	// ],
	// WarmThroughput: {
	// 	ReadUnitsPerSecond: number,
	// 	WriteUnitsPerSecond: number,
	// },
};

