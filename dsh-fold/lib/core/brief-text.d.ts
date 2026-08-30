export declare function boundedSubject(text: string, budget: number): string;
export declare function oneLine(value: string, maximum: number): string;
export declare function toolClipHead(text: string, cap: number): string;
export declare function usefulBriefWithin(value: unknown, maximum: number, toolName: string): value is string;
export declare function structurallyValidBriefWithin(value: unknown, maximum: number): value is string;
export declare function seatSubjects(subjects: readonly string[], lead: string, options: {
    readonly total: number;
    readonly minSubjectChars: number;
    readonly omittedNoun: string;
    readonly separator?: string;
}): string;
//# sourceMappingURL=brief-text.d.ts.map