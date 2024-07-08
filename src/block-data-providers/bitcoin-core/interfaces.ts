export interface Block {
    height: number;
    hash: string;
    tx: BlockTransaction[];
}

export type Input = CoinbaseInput | OrdinaryInput;

export const isCoinbaseInput = (input: Input): input is CoinbaseInput => {
    return (input as CoinbaseInput).coinbase !== undefined;
};

export interface BlockTransaction {
    txid: string;
    hash: string;
    vin: Input[];
    vout: Output[];
}

interface CoinbaseInput {
    coinbase: string;
    txinwitness: string[];
}

interface OrdinaryInput {
    txid: string;
    vout: number;
    scriptSig: {
        hex: string;
    };
    txinwitness: string[];
}

export interface Output {
    value: number;
    n: number;
    scriptPubKey: {
        hex: string;
    };
}
