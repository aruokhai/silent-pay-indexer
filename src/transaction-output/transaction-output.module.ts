import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionOutput } from '@/transaction-output/transaction-output.entity';

@Module({
    imports: [TypeOrmModule.forFeature([TransactionOutput])],
})
export class TransactionOutputModule {}
